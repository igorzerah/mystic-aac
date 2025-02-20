import 'dotenv/config';
import express, { Application } from 'express';
import cors from 'cors';
import path from 'path';
import helmet from 'helmet';
import session from 'express-session';
import compression from 'compression';
import methodOverride from 'method-override';
import http from 'http';

// Middleware
import { errorHandler } from './middleware/error-handler';
import { apiLimiter, loginLimiter } from './middleware/rate-limiter';
import { globalLogger, errorLogger } from './middleware/global-logger';

// Rotas
import authRoutes from './routes/auth';
import accountRoutes from './routes/account';
import newsRoutes from './routes/news';
import playerRoutes from './routes/players';

// Serviços
import prisma from './services/prisma';
import { cacheService } from './utils/cache';
import logger from './config/logger';

// Tipos para configuração de ambiente
interface EnvironmentConfig {
  port: number;
  databaseUrl: string;
  sessionSecret: string;
  corsOrigin: string[];
  serverName: string;
  nodeEnv: 'development' | 'production' | 'test';
}

class Server {
  private app: Application;
  private server: http.Server | null = null;
  private port: number;
  private config: EnvironmentConfig;

  constructor() {
    this.app = express();
    this.config = this.loadEnvironmentConfig();
    this.port = this.config.port;
    
    this.validateEnvironment();
    this.initializeMiddleware();
    this.initializeRoutes();
    this.initializeErrorHandling();
    this.setupGracefulShutdown();
  }

  private loadEnvironmentConfig(): EnvironmentConfig {
    const nodeEnv = process.env.NODE_ENV as EnvironmentConfig['nodeEnv'] || 'development';
    
    // Configurações padrão
    const defaultConfig: EnvironmentConfig = {
      port: 3000,
      databaseUrl: 'postgresql://localhost/default_db',
      sessionSecret: 'default_secret_key',
      corsOrigin: ['http://localhost:3000'],
      serverName: 'LocalServer',
      nodeEnv
    };

    // Sobrescrever configurações padrão com variáveis de ambiente
    const config: EnvironmentConfig = {
      port: parseInt(process.env.PORT || '3000', 10),
      databaseUrl: process.env.DATABASE_URL || defaultConfig.databaseUrl,
      sessionSecret: process.env.SESSION_SECRET || defaultConfig.sessionSecret,
      corsOrigin: process.env.CORS_ORIGIN?.split(',') || defaultConfig.corsOrigin,
      serverName: process.env.SERVER_NAME || defaultConfig.serverName,
      nodeEnv
    };

    return config;
  }

  private validateEnvironment() {
    const requiredVars: (keyof EnvironmentConfig)[] = [
      'port', 
      'databaseUrl', 
      'sessionSecret', 
      'corsOrigin', 
      'serverName'
    ];

    const missingVars = requiredVars.filter(varName => {
      const value = this.config[varName];
      return value === undefined || 
             (Array.isArray(value) && value.length === 0) ||
             (typeof value === 'string' && value.trim() === '');
    });

    if (missingVars.length > 0) {
      logger.error(`Variáveis de ambiente não definidas ou inválidas: ${missingVars.join(', ')}`);
      process.exit(1);
    }

    // Validações adicionais
    if (this.config.port < 0 || this.config.port > 65535) {
      logger.error(`Porta inválida: ${this.config.port}. Deve estar entre 0 e 65535`);
      process.exit(1);
    }

    // Configurações específicas de ambiente
    if (this.config.nodeEnv === 'development') {
      logger.info('🛠️ Modo de desenvolvimento ativado');
      // Configurações adicionais para desenvolvimento
      this.app.use((req, res, next) => {
        res.setHeader('X-Development-Mode', 'true');
        next();
      });
    }
  }

  private initializeMiddleware() {
    // Segurança
    this.app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
          imgSrc: ["'self'", "data:", "https:"]
        }
      }
    }));

    // Parsing
    this.app.use(express.urlencoded({ extended: true }));
    this.app.use(express.json());

    // Method Override
    this.app.use(methodOverride((req, res) => {
      if (req.query._method) {
        return req.query._method.toString().toUpperCase();
      }
      return '';
    }));

    // Usar configurações do ambiente
    this.app.use(cors({
      origin: this.config.corsOrigin,
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization']
    }));

    // Sessão com segredo do ambiente
    this.app.use(session({
      secret: this.config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: this.config.nodeEnv === 'production',
        maxAge: 24 * 60 * 60 * 1000 
      }
    }));

    // Logging global
    this.app.use(globalLogger);

    // Configurações do Express
    this.app.set('view engine', 'ejs');
    this.app.set('views', path.join(__dirname, '../views'));
    this.app.use(express.static(path.join(__dirname, '../public')));

    // Compressão
    this.app.use(compression());
  }

  private initializeRoutes() {
    // Healthcheck
    this.app.get('/health', (req, res) => {
      const healthcheck = {
        uptime: process.uptime(),
        message: 'OK',
        timestamp: Date.now(),
        database: prisma ? 'Connected' : 'Disconnected',
        cache: cacheService ? 'Initialized' : 'Not Available'
      };
      
      res.status(200).json(healthcheck);
    });

    // Rotas públicas com rate limiting
    this.app.use('/auth', loginLimiter, authRoutes);
    this.app.get('/logout', loginLimiter, (req, res, next) => {
      authRoutes(req, res, next);
    });
    this.app.use('/account', apiLimiter, accountRoutes);
    this.app.use('/news', newsRoutes);
    this.app.use('/players', playerRoutes);

    // Rota do dashboard
    this.app.get('/dashboard', (req, res, next) => {
      authRoutes(req, res, next);
    });

    // Rota inicial com cache
    this.app.get('/', apiLimiter, async (req, res, next) => {
      try {
        const cacheKey = 'home:dashboard';
        const cachedData = await cacheService.get(cacheKey);

        if (cachedData) {
          return res.render('pages/index', cachedData);
        }

        const [news, topPlayers, onlinePlayers, totalPlayers] = await Promise.all([
          prisma.news.findMany({
            orderBy: { date: 'desc' },
            take: 10
          }),
          prisma.player.findMany({
            orderBy: { level: 'desc' },
            take: 4,
            select: {
              id: true,
              name: true,
              level: true,
              vocation: true,
              avatar: true
            }
          }),
          prisma.account.count({
            where: { 
              lastLogin: {
                gte: new Date(Date.now() - 15 * 60 * 1000) // Últimos 15 minutos
              },
              isActive: true
            }
          }),
          prisma.player.count()
        ]);

        const homeData = { 
          title: 'Início',
          serverName: this.config.serverName,
          news,
          topPlayers,
          onlinePlayers,
          totalPlayers
        };

        await cacheService.set(cacheKey, homeData, 300); // Cache por 5 minutos

        res.render('pages/index', homeData);
      } catch (error) {
        next(error);
      }
    });
  }

  private initializeErrorHandling() {
    // Tratamento de rotas não encontradas
    this.app.use((req, res, next) => {
      res.status(404).render('pages/error', {
        title: 'Página não encontrada',
        message: 'A página que você está procurando não existe.'
      });
    });

    // Middleware de erro global
    this.app.use(errorHandler);
  }

  private setupGracefulShutdown() {
    const shutdown = (signal: string) => {
      logger.info(`Recebido sinal ${signal}. Iniciando desligamento gracioso...`);
      
      if (this.server) {
        this.server.close(async (err) => {
          if (err) {
            logger.error('Erro durante o fechamento do servidor', err);
            process.exitCode = 1;
          }

          try {
            // Fechar conexões do banco de dados
            await prisma.$disconnect();
            
            // Limpar cache
            await cacheService.reset();

            logger.info('Servidor desligado com sucesso');
            process.exit();
          } catch (disconnectError) {
            logger.error('Erro ao desconectar recursos', disconnectError);
            process.exit(1);
          }
        });
      } else {
        process.exit();
      }
    };

    // Capturar sinais de término
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  }

  public start() {
    try {
      // Conectar ao banco de dados antes de iniciar o servidor
      const startServer = async () => {
        await prisma.$connect();
        await cacheService.init();

        this.server = this.app.listen(this.port, () => {
          logger.info(`🚀 Servidor rodando na porta ${this.port} - Ambiente: ${this.config.nodeEnv}`);
        });
      };

      startServer().catch(error => {
        logger.error('Erro crítico ao iniciar o servidor', error);
        process.exit(1);
      });
    } catch (error) {
      logger.error('Erro ao iniciar o servidor:', error);
      process.exit(1);
    }
  }
}

// Iniciar servidor
const server = new Server();
server.start();
