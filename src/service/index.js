const port = 9360;

export default {
  mode: 'auto',
  port,
  pm2: {
    script: './service/server.js',
    env: {
      PORT: String(port),
    },
    autorestart: true,
  },
  urls({ host }) {
    return {
      openUrl: `http://${host}:${port}/`,
      healthUrl: `http://${host}:${port}/health`,
    };
  },
};
