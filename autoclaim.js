#!/usr/bin/env fibos
const FIBOS = require('fibos.js');
const Decimal = require('decimal.js');
const ssl = require('ssl');
ssl.loadRootCerts();
const config = require('./config');


class RewardClaimer {
  constructor(config) {
    this.config = config;
    this.fibos = FIBOS({
      chainId: this.config.chainId || "6aa7bd33b6b45192465afa3553dedb531acaaff8928cf64b70bd4c5e49b7ec6a",
      keyProvider: this.config.privateKey,
      httpEndpoint: this.config.httpEndpoint,
      logger: {
        log: null,
        error: null
      }
    });
  }

  async getProducer() {
    const producers = await this.fibos.getTableRows({
      "scope": "eosio",
      "code": "eosio",
      "table": "producers",
      "lower_bound": this.config.name,
      "limit": 1,
      "json": true
    });

    return producers.rows[0];
  }

  getRewardsInfo(producer, globalInfo) {
    let bpay = new Decimal(globalInfo.perblock_bucket)
      .mul(producer.unpaid_blocks)
      .div(globalInfo.total_unpaid_blocks)
      .div(10000)
      .toFixed(4);
    let vpay = new Decimal(globalInfo.pervote_bucket).mul(producer.total_votes)
      .div(globalInfo.total_producer_vote_weight)
      .div(10000)
      .toFixed(4);
    const lastClaimTime = producer.last_claim_time / 1000;
    const nextClaimTime = lastClaimTime + 86400000;
    const totalPay = new Decimal(bpay).add(vpay).toNumber();
    return { bpay, vpay, totalPay, lastClaimTime, nextClaimTime };
  }

  async getGlobalInfo() {
    const globalInfo = await this.fibos.getTableRows({
      "scope": "eosio",
      "code": "eosio",
      "table": "global",
      "json": true
    });
    if (!globalInfo.rows || !globalInfo.rows[0]) {
      throw new Error('Can not get global info.');
    }

    return globalInfo.rows[0];
  }

  async claim() {
    const contract = await this.fibos.contract("eosio");
    return contract.claimrewards(this.config.name);
  }


  async attemptClaim() {
    let producer;
    try {
      producer = await this.getProducer();
    } catch (e) {
      this.error('Get producer info failed, retry in 10 seconds later.', e);
      setTimeout(this.attemptClaim.bind(this), 10 * 1000);
      return;
    }
    let globalInfo;
    try {
      globalInfo = await this.getGlobalInfo();
    } catch (e) {
      this.error('Get global info failed, retry in 10 seconds later.', e);
      setTimeout(this.attemptClaim.bind(this), 10 * 1000);
      return;
    }

    let rewardsInfo;
    try {
      rewardsInfo = this.getRewardsInfo(producer, globalInfo);
      this.info(`Last claim time: ${new Date(rewardsInfo.lastClaimTime)}`);
      this.info(`Next claim time: ${new Date(rewardsInfo.nextClaimTime)}`);
      this.info('Rewards info', rewardsInfo);
    } catch (e) {
      this.error('Get rewards info failed, retry in 10 seconds later.', e);
      setTimeout(this.attemptClaim.bind(this), 10 * 1000);
      return;
    }

    let now = new Date().getTime();
    if (now < rewardsInfo.nextClaimTime) {
      const duration = rewardsInfo.nextClaimTime - now;
      this.error(`It is not time to claim, retry in ${duration / 1000} seconds later.`);
      setTimeout(this.attemptClaim.bind(this), duration);
      return;
    }
    if (rewardsInfo.totalPay < 1000) {
      this.error('Rewards less than 1000. retry in 30 minutes later');
      setTimeout(this.attemptClaim.bind(this), 30 * 60 * 1000);
      return;
    }
    try {
      await this.claim();
    } catch (e) {
      this.error('Rewards error. try in 10 seconds later');
      setTimeout(this.attemptClaim.bind(this), 10 * 1000);
      return;
    }

    this.info(`Claim success, set next claim timer to 86400 seconds later.`);
    setTimeout(this.attemptClaim.bind(this), 86400 * 1000);
  }

  info(...args) {
    console.info(`[${new Date()}] `, ...args)
  }

  error(...args) {
    console.error(`[${new Date()}] `, ...args)
  }
}

(async () => {
  await new RewardClaimer(config).attemptClaim();
})();
