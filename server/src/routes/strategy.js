const express = require('express');
const router  = express.Router();
const logger  = require('../utils/logger');

router.post('/toggle', (req, res) => {
  const { strategy, action } = req.body;
  
  // Mapping UI names to Backend instances
  const engineMap = {
    atmscalping: req.app.locals.scalpEngine,
    ironcondor: req.app.locals.icEngine,
    deltaneutral: req.app.locals.dnEngine
  };

  const engine = engineMap[strategy];

  if (!engine) {
    logger.error(`Engine not found for: ${strategy}`);
    return res.status(404).json({ success: false, message: "Engine not found" });
  }

  try {
    if (action === 'start') {
      engine.start();
      logger.info(`Started: ${strategy}`);
    } else {
      engine.stop();
      logger.info(`Stopped: ${strategy}`);
    }
    
    // Send success to stop the UI button from blinking
    return res.json({ success: true, strategy, running: engine.running });
  } catch (err) {
    logger.error(`Toggle Error: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;