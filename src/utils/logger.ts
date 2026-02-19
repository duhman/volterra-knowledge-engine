import winston from 'winston';

const { combine, timestamp, json, printf, colorize } = winston.format;

const logLevel = process.env.LOG_LEVEL || 'info';
const logFormat = process.env.LOG_FORMAT || 'json';

const consoleFormat = logFormat === 'json' 
  ? combine(timestamp(), json())
  : combine(
      colorize(),
      timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      printf(({ level, message, timestamp, ...meta }) => {
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        return `${timestamp} [${level}]: ${message}${metaStr}`;
      })
    );

export const logger = winston.createLogger({
  level: logLevel,
  format: combine(timestamp(), json()),
  defaultMeta: { service: 'document-ingestion' },
  transports: [
    new winston.transports.Console({
      format: consoleFormat,
    }),
  ],
});

// Add file transport in production
if (process.env.NODE_ENV === 'production') {
  logger.add(
    new winston.transports.File({ 
      filename: 'logs/error.log', 
      level: 'error' 
    })
  );
  logger.add(
    new winston.transports.File({ 
      filename: 'logs/combined.log' 
    })
  );
}

export function createChildLogger(context: Record<string, unknown>) {
  return logger.child(context);
}

