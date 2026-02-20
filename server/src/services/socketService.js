const logger = require('../utils/logger');

module.exports = (io) => {
  io.on('connection', (socket) => {
    logger.info(`🔌 Client connected: ${socket.id}`);

    socket.on('disconnect', () => {
      logger.info(`🔌 Client disconnected: ${socket.id}`);
    });

    // Manual exit from frontend
    socket.on('manual_exit', () => {
      const engine = global.tradingEngine;
      if (engine) {
        const result = engine.manualExit();
        socket.emit('manual_exit_result', result);
      }
    });

    // Get current status
    socket.on('get_status', () => {
      const engine = global.tradingEngine;
      if (engine) {
        socket.emit('status', engine.getStatus());
      }
    });
  });
};
