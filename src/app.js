// Merakit aplikasi Express: keamanan HTTP, file statis, API publik, dan API admin.
// Dibuat sebagai fungsi createApp() agar mudah diuji (test memberi pool & konfigurasi sendiri).
import crypto from 'node:crypto';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { PROJECT_ROOT } from './config/env.js';
import { createAuthMiddleware, createSameOriginGuard } from './middleware/auth.js';
import { createErrorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createRateLimiters } from './middleware/rateLimit.js';
import { createPaymentProvider } from './payments/index.js';
import { createPaymentService } from './services/paymentService.js';
import { createImageParser } from './middleware/upload.js';
import { createAdminRouter } from './routes/admin/index.js';
import { createPublicRouter } from './routes/public.js';

/**
 * @param {object} [options.paymentProvider] penyedia pembayaran siap pakai (untuk test); default dibuat dari konfigurasi.
 *        Beri null untuk memaksa QRIS nonaktif.
 */
export function createApp({ config, pool, logger, paymentProvider, clock }) {
  const app = express();
  const provider = paymentProvider === undefined ? createPaymentProvider(config.payment) : paymentProvider;
  const paymentService = createPaymentService({ pool, config, provider, logger, clock });
  app.locals.paymentService = paymentService; // dipakai server.js (sweeper) dan test
  app.disable('x-powered-by');
  // Di belakang reverse proxy (Nginx, Cloudflare, PaaS) isi TRUST_PROXY agar IP & HTTPS terbaca benar.
  app.set('trust proxy', config.trustProxy);

  // ------------------------------------------------------------ Log request (tanpa body/cookie)
  app.use((req, res, next) => {
    const startedAt = process.hrtime.bigint();
    req.id = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    res.on('finish', () => {
      logger.info('request', {
        id: req.id,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        ms: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
        ip: req.ip,
      });
    });
    next();
  });

  // ------------------------------------------------------------ HTTPS
  if (config.forceHttps) {
    app.use((req, res, next) => {
      if (req.secure) return next();
      return res.redirect(308, `https://${req.get('host')}${req.originalUrl}`);
    });
  }

  // ------------------------------------------------------------ Header keamanan (CSP, HSTS, dll.)
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", 'https://fonts.googleapis.com'],
          'font-src': ["'self'", 'https://fonts.gstatic.com'],
          // Gambar "Tentang Kami" memakai gambar dari kumparan.com (sudah ada di desain awal).
          'img-src': ["'self'", 'data:', 'https://blue.kumparan.com'],
          'frame-src': ['https://www.google.com'], // peta Google Maps
          'connect-src': ["'self'"],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
          'frame-ancestors': ["'none'"],
          ...(config.isProduction ? { 'upgrade-insecure-requests': [] } : {}),
        },
      },
      hsts: config.isProduction ? { maxAge: 15552000, includeSubDomains: true } : false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  // ------------------------------------------------------------ File statis
  // Ikon Feather disajikan dari paket npm lokal (bukan CDN pihak ketiga yang tidak terkunci versinya).
  app.get('/vendor/feather.min.js', (req, res) => {
    res.sendFile(path.join(PROJECT_ROOT, 'node_modules', 'feather-icons', 'dist', 'feather.min.js'), {
      maxAge: config.isProduction ? '7d' : 0,
    });
  });
  // Gambar unggahan admin. Nama file acak => aman di-cache lama.
  app.use(
    '/uploads',
    express.static(config.uploads.dir, {
      index: false,
      dotfiles: 'ignore',
      maxAge: config.isProduction ? '30d' : 0,
      immutable: config.isProduction,
    }),
  );
  // Dashboard admin tidak perlu muncul di mesin pencari.
  app.use('/admin', (req, res, next) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  });
  app.use(
    express.static(config.publicDir, {
      dotfiles: 'ignore',
      maxAge: config.isProduction ? '1h' : 0,
    }),
  );

  // ------------------------------------------------------------ API
  const limiters = createRateLimiters(config);
  const auth = createAuthMiddleware({ pool, config });
  const sameOriginGuard = createSameOriginGuard(config);

  const api = express.Router();
  if (config.corsOrigins.length > 0) {
    // CORS hanya untuk origin yang didaftarkan, tanpa credentials (cookie admin tidak ikut lintas origin).
    api.use(cors({ origin: config.corsOrigins, methods: ['GET', 'POST', 'OPTIONS'], maxAge: 600 }));
  }
  api.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); // stok & data admin selalu harus segar
    next();
  });
  api.use(limiters.api);
  api.use(express.json({ limit: '20kb' }));

  api.use(createPublicRouter({ pool, config, limiters, paymentService }));
  api.use(
    '/admin',
    sameOriginGuard,
    auth.loadSession,
    createAdminRouter({ pool, config, auth, limiters, paymentService, imageParser: createImageParser(config) }),
  );
  api.use(notFoundHandler);

  app.use('/api', api);
  app.use(createErrorHandler(logger));
  return app;
}
