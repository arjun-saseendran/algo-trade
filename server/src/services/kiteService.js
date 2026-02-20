const kiteconnect = require('kiteconnect');
const KiteConnect = kiteconnect.KiteConnect;
const logger  = require('../utils/logger');

class KiteService {
  constructor() {
    this.kite        = new KiteConnect({ api_key: process.env.KITE_API_KEY });
    this.connected   = false;
    this.accessToken = null;
  }

  // ── Authentication ──────────────────────
  getLoginUrl() {
    return this.kite.getLoginURL();
  }

  async generateSession(requestToken) {
    try {
      const session = await this.kite.generateSession(
        requestToken,
        process.env.KITE_API_SECRET
      );
      this.setAccessToken(session.access_token);
      return session;
    } catch (err) {
      logger.error('Session generation failed: ' + err.message);
      throw err;
    }
  }

  setAccessToken(token) {
    this.accessToken = token;
    this.kite.setAccessToken(token);
    this.connected = true;
    logger.info('Kite API connected ✅');
  }

  // ── Market Data ─────────────────────────
  async getLTP(instruments) {
    try {
      return await this.kite.getLTP(instruments);
    } catch (err) {
      logger.error('getLTP error: ' + err.message);
      throw err;
    }
  }

  async getQuote(instruments) {
    try {
      return await this.kite.getQuote(instruments);
    } catch (err) {
      logger.error('getQuote error: ' + err.message);
      throw err;
    }
  }

  async getHistoricalData(instrumentToken, interval, from, to) {
    try {
      return await this.kite.getHistoricalData(
        instrumentToken, interval, from, to
      );
    } catch (err) {
      logger.error('getHistoricalData error: ' + err.message);
      throw err;
    }
  }

  // ── Instruments ─────────────────────────
  async getInstruments(exchange = 'NFO') {
    try {
      return await this.kite.getInstruments([exchange]);
    } catch (err) {
      logger.error('getInstruments error: ' + err.message);
      throw err;
    }
  }

  // Find ATM option for given spot price
  async findATMOption(spotPrice, optionType, expiry = null) {
    try {
      const instruments = await this.getInstruments('NFO');

      // Filter NIFTY options
      let niftyOptions = instruments.filter(i =>
        i.name === 'NIFTY' &&
        i.instrument_type === optionType &&
        i.segment === 'NFO-OPT'
      );

      // Filter by expiry if provided
      if (expiry) {
        niftyOptions = niftyOptions.filter(i =>
          new Date(i.expiry).toDateString() === new Date(expiry).toDateString()
        );
      } else {
        // Get nearest expiry
        const now    = new Date();
        const expiries = [...new Set(niftyOptions.map(i => i.expiry))]
          .map(e => new Date(e))
          .filter(e => e >= now)
          .sort((a, b) => a - b);

        if (expiries.length === 0) throw new Error('No valid expiry found');

        const nearestExpiry = expiries[0];
        niftyOptions        = niftyOptions.filter(i =>
          new Date(i.expiry).toDateString() === nearestExpiry.toDateString()
        );
      }

      // Find ATM strike (closest to spot price)
      // NIFTY strikes are in multiples of 50
      const atmStrike = Math.round(spotPrice / 50) * 50;

      const atmOption = niftyOptions.find(i => i.strike === atmStrike);
      if (!atmOption) throw new Error(`ATM option not found for strike ${atmStrike}`);

      return atmOption;
    } catch (err) {
      logger.error('findATMOption error: ' + err.message);
      throw err;
    }
  }

  // ── Orders ──────────────────────────────
  async placeOrder(params) {
    try {
      const order = await this.kite.placeOrder('regular', {
        exchange:         'NFO',
        tradingsymbol:    params.tradingsymbol,
        transaction_type: this.kite.TRANSACTION_TYPE_BUY,
        quantity:         params.quantity,
        product:          this.kite.PRODUCT_MIS,   // Intraday
        order_type:       this.kite.ORDER_TYPE_MARKET,
        validity:         this.kite.VALIDITY_DAY,
        tag:              'ALGO_SCALP'
      });
      logger.info(`Order placed: ${params.tradingsymbol} qty:${params.quantity} orderId:${order.order_id}`);
      return order;
    } catch (err) {
      logger.error('placeOrder error: ' + err.message);
      throw err;
    }
  }

  async placeSLOrder(params) {
    try {
      const order = await this.kite.placeOrder('regular', {
        exchange:         'NFO',
        tradingsymbol:    params.tradingsymbol,
        transaction_type: this.kite.TRANSACTION_TYPE_SELL,
        quantity:         params.quantity,
        product:          this.kite.PRODUCT_MIS,
        order_type:       this.kite.ORDER_TYPE_SL,
        trigger_price:    params.triggerPrice,
        price:            params.triggerPrice - 2, // limit below trigger
        validity:         this.kite.VALIDITY_DAY,
        tag:              'ALGO_SCALP_SL'
      });
      logger.info(`SL order placed: ${params.tradingsymbol} trigger:${params.triggerPrice}`);
      return order;
    } catch (err) {
      logger.error('placeSLOrder error: ' + err.message);
      throw err;
    }
  }

  async placeTargetOrder(params) {
    try {
      const order = await this.kite.placeOrder('regular', {
        exchange:         'NFO',
        tradingsymbol:    params.tradingsymbol,
        transaction_type: this.kite.TRANSACTION_TYPE_SELL,
        quantity:         params.quantity,
        product:          this.kite.PRODUCT_MIS,
        order_type:       this.kite.ORDER_TYPE_LIMIT,
        price:            params.targetPrice,
        validity:         this.kite.VALIDITY_DAY,
        tag:              'ALGO_SCALP_TGT'
      });
      logger.info(`Target order placed: ${params.tradingsymbol} target:${params.targetPrice}`);
      return order;
    } catch (err) {
      logger.error('placeTargetOrder error: ' + err.message);
      throw err;
    }
  }

  async modifyOrder(orderId, params) {
    try {
      return await this.kite.modifyOrder('regular', orderId, params);
    } catch (err) {
      logger.error('modifyOrder error: ' + err.message);
      throw err;
    }
  }

  async cancelOrder(orderId) {
    try {
      return await this.kite.cancelOrder('regular', orderId);
    } catch (err) {
      logger.error('cancelOrder error: ' + err.message);
      throw err;
    }
  }

  async exitPosition(tradingsymbol, quantity) {
    try {
      const order = await this.kite.placeOrder('regular', {
        exchange:         'NFO',
        tradingsymbol,
        transaction_type: this.kite.TRANSACTION_TYPE_SELL,
        quantity,
        product:          this.kite.PRODUCT_MIS,
        order_type:       this.kite.ORDER_TYPE_MARKET,
        validity:         this.kite.VALIDITY_DAY,
        tag:              'ALGO_SCALP_EXIT'
      });
      logger.info(`Exit order placed: ${tradingsymbol}`);
      return order;
    } catch (err) {
      logger.error('exitPosition error: ' + err.message);
      throw err;
    }
  }

  async getPositions() {
    try {
      return await this.kite.getPositions();
    } catch (err) {
      logger.error('getPositions error: ' + err.message);
      throw err;
    }
  }

  async getOrders() {
    try {
      return await this.kite.getOrders();
    } catch (err) {
      logger.error('getOrders error: ' + err.message);
      throw err;
    }
  }

  isConnected() {
    return this.connected;
  }
}

// Singleton
const kiteService = new KiteService();
module.exports     = kiteService;
