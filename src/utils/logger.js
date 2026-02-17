import winston from 'winston';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// In production, you might want to add file transport or external service
if (process.env.NODE_ENV === 'production') {
  logger.add(new winston.transports.File({ 
    filename: '/tmp/error.log', 
    level: 'error' 
  }));
  logger.add(new winston.transports.File({ 
    filename: '/tmp/combined.log' 
  }));
}

export default logger;
