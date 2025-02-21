import 'dotenv/config';
import express, { Application } from 'express';
import cors from 'cors';
import path from 'path';
import helmet from 'helmet';
import session from 'express-session';
import compression from 'compression';
import methodOverride from 'method-override';
import http from 'http';
import Redis from 'ioredis';
import * as connectRedisModule from 'connect-redis';

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

  private async initializeMiddleware() {
    // Segurança
    this.app.use(helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
          imgSrc: ["'self'", "data:", "https:"]
        }
      },
      // Desabilitar algumas proteções para desenvolvimento/teste
      hsts: this.config.nodeEnv === 'production',
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
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

    // Servir arquivos estáticos ANTES de outras rotas
    const staticOptions = {
      dotfiles: 'ignore',
      etag: true,
      extensions: ['css', 'js', 'png', 'jpg', 'jpeg', 'gif', 'svg'],
      index: false,
      maxAge: this.config.nodeEnv === 'production' ? '1d' : 0,
      redirect: false,
      setHeaders: (res: express.Response, path: string) => {
        if (path.endsWith('.css')) {
          res.setHeader('Content-Type', 'text/css');
        } else if (path.endsWith('.js')) {
          res.setHeader('Content-Type', 'application/javascript');
        }
      }
    };

    // Múltiplos diretórios de arquivos estáticos
    this.app.use(express.static(path.join(__dirname, '../public'), staticOptions));
    this.app.use('/images', express.static(path.join(__dirname, '../public/images'), staticOptions));
    this.app.use('/js', express.static(path.join(__dirname, '../public/js'), staticOptions));

    // Configuração do Redis com opções de reconexão
    const redisClient = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      db: parseInt(process.env.REDIS_DB || '0', 10),
      password: process.env.REDIS_PASSWORD,
      retryStrategy: (times) => {
        // Estratégia de reconexão exponencial
        const delay = Math.min(times * 50, 2000);
        logger.warn(`Tentativa de reconexão Redis (${times}). Próxima em ${delay}ms`);
        return delay;
      },
      maxRetriesPerRequest: 3
    });

    redisClient.on('error', (err) => {
      logger.error('Erro na conexão Redis:', err);
    });

    redisClient.on('connect', () => {
      logger.info('Conexão Redis estabelecida com sucesso');
    });

    // Remover chamada de connect() para evitar conflitos
    try {
      // Verificar se o cliente já está conectado
      if (redisClient.status !== 'ready') {
        await new Promise<void>((resolve, reject) => {
          redisClient.once('ready', () => resolve());
          redisClient.once('error', (err) => reject(err));
        });
      }
    } catch (error) {
      logger.error('Falha ao conectar com Redis:', error);
      logger.warn('Usando MemoryStore como fallback');
    }

    // Diagnóstico detalhado
    logger.info('Módulo connect-redis - Tipo:', typeof connectRedisModule);
    logger.info('Módulo connect-redis - Chaves:', JSON.stringify(Object.keys(connectRedisModule)));

    try {
      let RedisStore: any;

      // Estratégias de importação
      if (typeof connectRedisModule === 'function') {
        RedisStore = connectRedisModule;
      } 
      else if (typeof (connectRedisModule as any).default === 'function') {
        RedisStore = (connectRedisModule as any).default;
      } 
      else if (typeof (connectRedisModule as any).RedisStore === 'function') {
        RedisStore = (connectRedisModule as any).RedisStore;
      }
      else {
        throw new Error('Nenhuma estratégia de importação válida encontrada');
      }

      logger.info('Estratégia de importação:', RedisStore.name || 'Anônima');

      // Inicialização do RedisStore
      const redisStore = new RedisStore({ 
        client: redisClient,
        prefix: 'sess:',
        // Configurações adicionais de segurança
        ttl: 86400, // 1 dia em segundos
        disableTouch: false // Permite atualizar a expiração da sessão
      });
      
      this.app.use(session({
        store: redisStore,
        secret: this.config.sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: {
          secure: this.config.nodeEnv === 'production', 
          httpOnly: true,
          maxAge: 1000 * 60 * 60 * 24 
        }
      }));
    } catch (error) {
      logger.error('Erro CRÍTICO ao configurar RedisStore:', error);
      
      // Fallback para MemoryStore com logs de aviso
      logger.warn('🚨 AVISO CRÍTICO: Usando MemoryStore em produção. ALTAMENTE NÃO RECOMENDADO! 🚨');
      
      this.app.use(session({
        secret: this.config.sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: {
          secure: this.config.nodeEnv === 'production',
          httpOnly: true,
          maxAge: 1000 * 60 * 60 * 24
        }
      }));
    }

    // Logging global
    this.app.use(globalLogger);

    // Configurações do Express
    this.app.set('view engine', 'ejs');
    this.app.set('views', path.join(__dirname, '../views'));

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
