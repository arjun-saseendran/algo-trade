const logger = require('../utils/logger');

module.exports = (io, engines) => {
  // engines = { scalpEngine, icEngine, dnEngine }
  const { scalpEngine } = engines;

  io.on('connection', (socket) => {
    logger.info(`🔌 Client connected: ${socket.id}`);

    socket.on('disconnect', () => {
      logger.info(`🔌 Client disconnected: ${socket.id}`);
    });

    // FIX 3: Return real status from scalpEngine instead of undefined global
    socket.on('get_status', () => {
      const status = scalpEngine ? scalpEngine.getStatus() : { running: false, paperTrade: true };
      socket.emit('status', status);
    });

    // Manual exit from frontend
    socket.on('manual_exit', () => {
      if (scalpEngine) {
        scalpEngine.closeAll('MANUAL_EXIT').catch(err =>
          logger.error('Manual exit error: ' + err.message)
        );
        socket.emit('manual_exit_result', { success: true });
      }
    });
  });
};
