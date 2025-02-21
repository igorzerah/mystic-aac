# Tibia Website

## Prerequisites
- Node.js (v16+)
- npm
- Redis

## Redis Installation

### Windows
1. **Using Windows Subsystem for Linux (WSL2) (Recommended)**:
   ```bash
   # Install WSL2 and Ubuntu
   wsl --install
   
   # Open Ubuntu terminal and run:
   sudo apt update
   sudo apt install redis-server
   
   # Start Redis service
   sudo service redis-server start
   ```

2. **Manual Installation**:
   - Download Redis from official website: https://github.com/tporadowski/redis/releases
   - Extract and run `redis-server.exe`
   - Add to PATH for command-line access

### macOS
```bash
brew update
brew install redis

# Start Redis service
brew services start redis
```

### Linux (Ubuntu/Debian)
```bash
sudo apt update
sudo apt install redis-server

# Start Redis service
sudo systemctl start redis-server
sudo systemctl enable redis-server
```

### Verify Redis Installation
```bash
# Check Redis is running
redis-cli ping
# Should return "PONG"
```

## Setup
1. Clone the repository
2. Run `npm install`
3. Configure `.env` with Redis connection details
4. Run `npm run dev` for development
5. Run `npm run build` to compile TypeScript
6. Run `npm start` to run the production build

## Development
- `npm run dev`: Start development server
- `npm run build`: Compile TypeScript
- `npm run lint`: Run ESLint

## Technologies
- Node.js
- TypeScript
- Express.js
- Redis (Session Management)

## Troubleshooting
- Ensure Redis is running before starting the application
- Check firewall settings if connection fails
- Verify Redis port (default: 6379) is not blocked
