// QQ is a transport into the existing in-process pet conversation, never an agent.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export const QQ_CHAT = Symbol.for('dsh.pet.external.chat.v1');
export const QQ_OUTBOUND = Symbol.for('dsh.pet.external.outbound.v1');
const groupReplyLimit = 15;
const groupCharacters = new Intl.Segmenter('zh', { granularity: 'grapheme' });
export function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  if (process.platform === 'win32' && path.basename(file) === 'qq-config.json') {
    const user = process.env.USERDOMAIN + '\\' + process.env.USERNAME;
    try {
      execFileSync('icacls.exe', [tmp, '/inheritance:r', '/grant:r', user + ':(F)', '*S-1-5-18:(F)'], { windowsHide: true, stdio: 'ignore' });
    } catch (error) { fs.unlinkSync(tmp); throw error; }
  }
  fs.renameSync(tmp, file);
}
export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
const equal = (a, b) => {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

export class QQPetBridge {
  constructor(config, options = {}) {
    this.config = config;
    this.fetch = options.fetch || globalThis.fetch;
    this.WebSocket = options.WebSocket || globalThis.WebSocket;
    this.chat = options.chat || ((...args) => {
      const invoke = globalThis[QQ_CHAT];
      if (typeof invoke !== 'function') throw Error('pet-not-ready');
      return invoke(...args);
    });
    this.canSpeak = options.canSpeak || (() => globalThis[Symbol.for('dsh.pet.companion.v1')]?.speechAllowed?.(this.config.petId || 'main') === true);
    this.now = options.now || Date.now;
    this.saveConfig = options.saveConfig || (() => {});
    this.saveReceipts = options.saveReceipts || (() => {});
    this.status = options.status || (() => {});
    this.seen = new Map(options.receipts || []);
    this.outboundSeen = new Map(options.outboundReceipts || []);
    this.saveOutbound = options.saveOutbound || (() => {});
    this.proactiveSpacing = options.proactiveSpacing ?? 3100;
    this.proactiveQueue = Promise.resolve();
    this.proactivePending = 0;
    this.queue = Promise.resolve();
    this.pending = 0;
    this.groupQuietMs = options.groupQuietMs ?? 4000;
    this.groupMaxWaitMs = options.groupMaxWaitMs ?? 12000;
    this.groupCooldownMs = options.groupCooldownMs ?? 10000;
    this.groupSources = new WeakMap();
    this.groupSent = new Set();
    this.attempt = 0;
    this.stopped = false;
    this.abort = new AbortController();
    this.base = config.sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.bot.qq.com';
  }
  setStatus(state, reason) {
    this.connectionState = state;
    this.connectionReason = reason;
    try { this.status({ state, ...(reason ? { reason } : {}), at: this.now(), paired: !!this.config.ownerOpenid,
      groups: { enabled: this.config.groupEnabled === true, paired: !!this.config.groupOpenid, mode: this.config.groupMode || 'owner', maxReplyChars: groupReplyLimit, replyStyle: 'generated-short-sentence',
        replyCadence: this.groupQuietMs > 0 ? 'merge-after-pause' : 'immediate', quietMs: this.groupQuietMs, pendingMessages: this.groupBatch?.items.length || 0,
        audiencePolicy: 'contextual-turn-taking',
        ...(this.lastGroupEventType ? { lastEventType: this.lastGroupEventType } : {}),
        ...(this.lastGroupEventAt ? { lastEventAt: this.lastGroupEventAt } : {}), ...(this.lastGroupReplyAt ? { lastReplyAt: this.lastGroupReplyAt } : {}) },
      speechAllowed: this.speechAllowed(), identityPolicy: 'bound-owner-only',
      ...(this.outboundStatus ? { proactive: this.outboundStatus } : {}) }); }
    catch { /* A status file failure must not create an unhandled rejection. */ }
  }
  speechAllowed() { try { return this.canSpeak() === true; } catch { return false; } }
  setOutbound(state, reason) {
    this.outboundStatus = { state, at: this.now(), ...(reason ? { reason } : {}) };
    this.setStatus(this.connectionState || 'online', this.connectionReason);
  }
  async token() {
    if (this.access && this.expiresAt > this.now() + 60000) return this.access;
    if (this.tokenTask) return this.tokenTask;
    this.tokenTask = (async () => {
      const response = await this.fetch('https://api.bot.qq.com/app/getAppAccessToken', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appId: this.config.appId, clientSecret: this.config.appSecret }),
        signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]),
      });
      const data = await response.json();
      if (!response.ok || !data.access_token) throw Error('qq-auth-failed');
      this.access = data.access_token;
      this.expiresAt = this.now() + Math.max(60, Number(data.expires_in) || 7200) * 1000;
      return this.access;
    })();
    try { return await this.tokenTask; } finally { this.tokenTask = null; }
  }
  requiresPermit() { return globalThis[Symbol.for('dsh.pet.companion.v1')]?.store?.read?.(this.config.petId || 'main')?.wallet?.balance === 0; }
  permitValid(token) { return globalThis[Symbol.for('dsh.pet.companion.v1')]?.validSpeechPermit?.(this.config.petId || 'main',token) === true; }
  async api(route, body, permit, proactive = false, group = false) {
    if (body && route.endsWith('/messages') && group && this.requiresPermit()) throw Error('qq-wallet-empty');
    if (body && route.endsWith('/messages') && (!this.speechAllowed() || (proactive && this.requiresPermit())) && !this.permitValid(permit)) throw Error('qq-wallet-empty');
    const access = await this.token();
    if (body && route.endsWith('/messages') && group && this.requiresPermit()) throw Error('qq-wallet-empty');
    if (body && route.endsWith('/messages') && (!this.speechAllowed() || (proactive && this.requiresPermit())) && !this.permitValid(permit)) throw Error('qq-wallet-empty');
    const response = await this.fetch(this.base + route, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'QQBot ' + access, 'X-Union-Appid': this.config.appId, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok) {
      if (response.status === 401) this.expiresAt = 0;
      // Never log QQ response bodies, credentials, or conversation contents.
      let code;
      try { const data = await response.json(); if (/^\d+$/.test(String(data.code))) code = String(data.code); } catch { /* non-JSON response */ }
      throw Error('qq-http-' + response.status + (code ? '-code-' + code : ''));
    }
    return response.json();
  }
  async start() {
    if (this.stopped) return;
    clearTimeout(this.retry);
    this.setStatus('connecting');
    try {
      if (typeof this.WebSocket !== 'function') throw Error('websocket-unavailable');
      const gateway = await this.api('/gateway');
      if (this.stopped) return;
      if (new URL(gateway.url).protocol !== 'wss:') throw Error('invalid-gateway');
      const socket = this.socket = new this.WebSocket(gateway.url);
      socket.addEventListener('message', event => {
        if (this.stopped || this.socket !== socket) return;
        void this.packet(event.data, socket).catch(() => this.reconnect(socket));
      });
      socket.addEventListener('error', () => this.reconnect(socket));
      socket.addEventListener('close', event => {
        if (this.socket !== socket || this.stopped) return;
        if ([4004, 4010, 4011, 4013, 4014].includes(event.code)) {
          this.halt('gateway-permission-' + event.code);
        } else {
          if ([4007, 4009].includes(event.code)) { this.session = null; this.sequence = null; }
          this.reconnect(socket);
        }
      });
      this.connectTimeout = setTimeout(() => this.reconnect(socket), 30000);
      this.connectTimeout.unref?.();
    } catch (error) {
      if (this.stopped) return;
      if (['qq-auth-failed', 'websocket-unavailable', 'invalid-gateway'].includes(error.message)) this.halt(error.message);
      else this.reconnect();
    }
  }
  send(socket, packet) {
    if (!this.stopped && this.socket === socket && socket.readyState === 1) socket.send(JSON.stringify(packet));
  }
  async packet(raw, socket) {
    if (typeof raw !== 'string' || raw.length > 1048576) throw Error('invalid-packet');
    const packet = JSON.parse(raw);
    if (Number.isInteger(packet.s)) this.sequence = packet.s;
    if (packet.op === 10) {
      const interval = Number(packet.d?.heartbeat_interval);
      if (!Number.isFinite(interval) || interval < 1000) throw Error('invalid-heartbeat');
      clearInterval(this.heartbeat);
      this.acked = true;
      this.heartbeat = setInterval(() => {
        if (!this.acked) return this.reconnect(socket);
        this.acked = false;
        this.send(socket, { op: 1, d: this.sequence ?? null });
      }, interval);
      this.heartbeat.unref?.();
      const token = 'QQBot ' + await this.token();
      this.send(socket, this.session
        ? { op: 6, d: { token, session_id: this.session, seq: this.sequence } }
        : { op: 2, d: { token, intents: 1 << 25, shard: [0, 1], properties: {} } });
    } else if (packet.op === 11) this.acked = true;
    else if (packet.op === 1) this.send(socket, { op: 1, d: this.sequence ?? null });
    else if (packet.op === 7) this.reconnect(socket);
    else if (packet.op === 9) {
      this.session = null; this.sequence = null;
      // A denied intent must not turn into an authentication retry loop.
      this.halt('gateway-invalid-session');
    } else if (packet.op === 0) {
      if (packet.t === 'READY' || packet.t === 'RESUMED') {
        clearTimeout(this.connectTimeout);
        if (packet.t === 'READY') {
          this.session = packet.d?.session_id;
          this.botId = typeof packet.d?.user?.id === 'string' ? packet.d.user.id : undefined;
        }
        this.attempt = 0;
        this.setStatus('online');
      } else if (packet.t === 'C2C_MESSAGE_CREATE') {
        void this.receive(packet.d).catch(() => { if (!this.stopped) this.setStatus('message-failed', 'local-or-delivery-error'); });
      } else if (this.config.groupEnabled === true && (packet.t === 'GROUP_AT_MESSAGE_CREATE' ||
          (packet.t === 'GROUP_MESSAGE_CREATE' && this.config.groupMode === 'all'))) {
        this.lastGroupEventAt = this.now();
        this.lastGroupEventType = packet.t;
        this.setStatus(this.connectionState || 'online', this.connectionReason);
        void this.receive(packet.d, 'group', packet.t).catch(() => { if (!this.stopped) this.setStatus('message-failed', 'group-local-or-delivery-error'); });
      }
    }
  }
  reconnect(socket = this.socket) {
    if (this.stopped || (socket && socket !== this.socket)) return;
    clearInterval(this.heartbeat); clearTimeout(this.connectTimeout);
    this.socket = null;
    try { socket?.close(); } catch { /* already closed */ }
    if (this.retry) return;
    this.setStatus('reconnecting');
    const delay = Math.min(60000, 3000 * 2 ** Math.min(this.attempt++, 5)) + Math.floor(Math.random() * 1000);
    this.retry = setTimeout(() => { this.retry = null; void this.start(); }, delay);
    this.retry.unref?.();
  }
  halt(reason) {
    this.setStatus('needs-attention', reason);
    this.stop();
  }
  async reply(message, content, scene = 'c2c', permit) {
    if (this.stopped || !this.speechAllowed() || (scene === 'group' && this.requiresPermit())) return;
    if (scene === 'group' && [...groupCharacters.segment(content.trim())].length > groupReplyLimit) throw Error('group-reply-too-long');
    const route = scene === 'group' ? '/v2/groups/' + encodeURIComponent(message.group_openid) : '/v2/users/' + encodeURIComponent(message.author.user_openid);
    const result = await this.api(route + '/messages', {
      content: scene === 'group' ? content.trim() : content.slice(0, 1800), msg_type: 0, msg_id: message.id, msg_seq: 1,
    }, permit, false, scene === 'group');
    if (scene === 'group' && typeof result?.id === 'string') {
      this.groupSent.add(result.id);
      while (this.groupSent.size > 64) this.groupSent.delete(this.groupSent.values().next().value);
    }
    return result;
  }
  subscribeProactive() {
    this.outboundSink = (petId, item) => this.forwardProactive(petId, item);
    globalThis[QQ_OUTBOUND] = this.outboundSink;
  }
  forwardProactive(petId, item) {
    if (this.stopped || !this.config.ownerOpenid || petId !== (this.config.petId || 'main') ||
        typeof item?.id !== 'string' || !item.id || typeof item.text !== 'string' || !item.text.trim() ||
        this.outboundSeen.has(item.id)) return Promise.resolve(false);
    if (this.proactivePending >= 64) { this.setOutbound('failed', 'proactive-queue-full'); return Promise.resolve(false); }
    // Reserve before scheduling so duplicate publication cannot enter twice.
    this.outboundSeen.set(item.id, { at: this.now(), state: 'queued' });
    this.proactivePending++;
    const task = this.proactiveQueue.then(async () => {
      if (this.stopped) return false;
      const wait = Math.max(0, (this.lastProactiveAt ?? -Infinity) + this.proactiveSpacing - this.now());
      if (wait) await delay(wait, undefined, { signal: this.abort.signal });
      if (this.stopped) return false;
      // Persist the attempt before POST. Ambiguous network failures are not retried.
      this.lastProactiveAt = this.now();
      this.outboundSeen.set(item.id, { at: this.now(), state: 'sending' });
      while (this.outboundSeen.size > 2000) this.outboundSeen.delete(this.outboundSeen.keys().next().value);
      this.saveOutbound([...this.outboundSeen]);
      try {
        if ((!this.speechAllowed() || this.requiresPermit()) && !this.permitValid(item.speechPermit)) throw Error('qq-wallet-empty');
        const response = await this.api('/v2/users/' + encodeURIComponent(this.config.ownerOpenid) + '/messages', {
          content: item.text.trim().slice(0, 1800), msg_type: 0,
        }, item.speechPermit, true);
        if (!response?.id) throw Error('qq-missing-message-receipt');
        this.outboundSeen.set(item.id, { at: this.now(), state: 'sent' });
        this.saveOutbound([...this.outboundSeen]);
        this.setOutbound('sent');
        return true;
      } catch (error) {
        this.outboundSeen.set(item.id, { at: this.now(), state: error.message === 'qq-wallet-empty' ? 'blocked' : 'failed' });
        this.saveOutbound([...this.outboundSeen]);
        if (!this.stopped) this.setOutbound(error.message === 'qq-wallet-empty' ? 'blocked' : 'failed', /^qq-[a-z0-9-]+$/.test(error.message) ? error.message : 'proactive-send-failed');
        return false;
      }
    });
    this.proactiveQueue = task.catch(() => {
      if (!this.stopped) this.setOutbound('failed', 'proactive-send-or-storage-failed');
      return false;
    }).finally(() => { this.proactivePending--; });
    return this.proactiveQueue;
  }
  remember(id) {
    this.seen.set(id, this.now());
    for (const [key, at] of this.seen) if (at < this.now() - 86400000) this.seen.delete(key);
    while (this.seen.size > 2000) this.seen.delete(this.seen.keys().next().value);
    this.saveReceipts([...this.seen]);
  }
  groupIdentity(message) {
    const actor = message.author.member_openid;
    const isDad = equal(actor, this.config.groupOwnerOpenid || '');
    const nickname = String(message.author.username || '群友').replace(/[\r\n\x00-\x1f]/g, '').slice(0, 32);
    return { speaker: isDad ? '爸爸' : /爸/.test(nickname) ? '群友' : nickname,
      participant: crypto.createHash('sha256').update(actor).digest('hex').slice(0, 8), isDad };
  }
  groupAddressing(message) {
    const source = this.groupSources.get(message);
    const mentions = (Array.isArray(message.mentions) ? message.mentions : []).slice(0, 16).map(item => {
      const id = String(item?.id || item?.member_openid || item?.user_openid || '');
      return { name: String(item?.username || '').replace(/[\x00-\x1f]/g, '').slice(0, 32),
        participant: id ? crypto.createHash('sha256').update(id).digest('hex').slice(0, 8) : '',
        isPet: this.botId && id ? id === this.botId : null, bot: item?.bot === true };
    });
    const quote = {};
    for (const key of ['message_reference', 'message_scene', 'msg_elements']) {
      if (message[key] && typeof message[key] === 'object') quote[key] = message[key];
    }
    return { senderIsBot: message.author.bot === true,
      explicitlyMentionedPet: source === 'GROUP_AT_MESSAGE_CREATE' || mentions.some(item => item.isPet === true),
      mentions, ...(Object.keys(quote).length ? { quoteData: JSON.stringify(quote).slice(0, 2400) } : {}) };
  }
  discardGroupBatch() {
    clearTimeout(this.groupTimer); this.groupTimer = null;
    const batch = this.groupBatch; this.groupBatch = null;
    batch?.resolve();
  }
  scheduleGroupBatch() {
    clearTimeout(this.groupTimer); this.groupTimer = null;
    if (!this.groupBatch || this.groupActive || this.stopped) return;
    const due = Math.max(Math.min(this.now() + this.groupQuietMs, this.groupBatch.started + this.groupMaxWaitMs),
      (this.lastGroupReplyAt ?? -Infinity) + this.groupCooldownMs);
    this.groupTimer = setTimeout(() => this.flushGroupBatch(), Math.max(0, due - this.now()));
  }
  collectGroupMessage(message) {
    if (!this.groupBatch) {
      const batch = { items: [], started: this.now() };
      batch.promise = new Promise(resolve => { batch.resolve = resolve; });
      this.groupBatch = batch;
    }
    const batch = this.groupBatch;
    batch.items.push(message);
    while (batch.items.length > 24 || batch.items.length > 1 && batch.items.reduce((n, item) => n + item.content.length, 0) > 6000) batch.items.shift();
    this.scheduleGroupBatch();
    this.setStatus(this.connectionState || 'online', this.connectionReason);
    return batch.promise;
  }
  flushGroupBatch() {
    clearTimeout(this.groupTimer); this.groupTimer = null;
    if (!this.groupBatch || this.groupActive) return;
    const batch = this.groupBatch; this.groupBatch = null;
    if (this.stopped || !this.speechAllowed()) { batch.resolve(); return; }
    const message = batch.items.at(-1);
    const input = batch.items.length === 1 ? message.content.trim()
      : '【合并的连续群消息，按时间顺序；结合当前话题只回复一句，不逐条作答】\n' +
        JSON.stringify(batch.items.map(item => ({ ...this.groupIdentity(item), addressing: this.groupAddressing(item), text: item.content.trim() })));
    this.groupActive = true;
    const commandText=batch.items.filter(item=>this.groupIdentity(item).isDad).map(item=>item.content.trim()).join('\n');
    void this.enqueueTurn(message, 'group', input, {commandText}).catch(() => {
      if (!this.stopped) this.setStatus('message-failed', 'group-local-or-delivery-error');
    }).finally(() => {
      this.groupActive = false; batch.resolve(); this.scheduleGroupBatch();
    });
  }
  async receive(message, scene = 'c2c', eventType = '') {
    const isGroup = scene === 'group';
    const actor = isGroup ? message?.author?.member_openid : message?.author?.user_openid;
    if (this.stopped || !message || typeof message.id !== 'string' || !message.id ||
        typeof actor !== 'string' || !actor || typeof message.content !== 'string') return;
    // Other bots can join the conversation; never consume our own echoed reply.
    if (isGroup && this.botId && equal(actor, this.botId)) return;
    if (isGroup && this.groupSent.has(message.id)) return;
    if (message.author.bot === true && (!isGroup || !this.botId)) return;
    if (isGroup && (this.config.groupEnabled !== true || typeof message.group_openid !== 'string' || !message.group_openid)) return;
    if (isGroup) this.groupSources.set(message, eventType);
    const owner = actor, input = message.content.trim();
    const receiptKey = isGroup ? 'group:' + message.id : message.id;
    const age = this.now() - Date.parse(message.timestamp);
    if (!input || input.length > 2000 || this.seen.has(receiptKey) || (Number.isFinite(age) && (age > 240000 || age < -60000))) return;
    if (isGroup) {
      if (!this.config.ownerOpenid) return;
      if (this.config.groupPairingCode && Number.isFinite(this.config.groupPairingExpiresAt) &&
          this.config.groupPairingExpiresAt >= this.now() && equal(input, '/绑定群 ' + this.config.groupPairingCode)) {
        const updated = { ...this.config, groupOpenid: message.group_openid, groupOwnerOpenid: owner };
        delete updated.groupPairingCode; delete updated.groupPairingExpiresAt;
        this.remember(receiptKey);
        this.saveConfig(updated); this.config = updated;
        await this.reply(message, this.config.groupMode === 'all'
          ? '绑定好啦，不用艾特也能聊。'
          : this.config.groupMode === 'mentions'
          ? '绑定好啦，大家艾特我就能聊。'
          : '绑定好啦，主人艾特我就能聊。', scene);
        this.lastGroupReplyAt = this.now(); this.setStatus('online');
        return;
      }
      if (!this.config.groupOpenid || !equal(message.group_openid, this.config.groupOpenid)) return;
      if (!['mentions', 'all'].includes(this.config.groupMode) && !equal(owner, this.config.groupOwnerOpenid || '')) return;
    } else if (!this.config.ownerOpenid) {
      if (!this.config.pairingCode || !Number.isFinite(this.config.pairingExpiresAt) || this.config.pairingExpiresAt < this.now() ||
          !equal(input, '/绑定 ' + this.config.pairingCode)) return;
      // Claim synchronously before awaiting anything, to exclude a second owner.
      const updated = { ...this.config, ownerOpenid: owner };
      delete updated.pairingCode; delete updated.pairingExpiresAt;
      this.remember(message.id);
      this.saveConfig(updated);
      this.config = updated;
      this.setStatus('online');
      await this.reply(message, '绑定好了。这里的消息会直接交给你本机的宠物，和桌面共用同一段相处。');
      return;
    }
    if (!isGroup && !equal(owner, this.config.ownerOpenid)) return;
    const forcePromptDuel = isGroup && input === '007' && equal(owner, this.config.groupOwnerOpenid || '');
    if (this.pending >= 4 && !forcePromptDuel) return;
    // Persist before the model call: redeliveries never repeat a pet action.
    this.remember(receiptKey);
    if (isGroup && globalThis[Symbol.for('dsh.pet.companion.v1')]?.store?.read?.(this.config.petId || 'main')?.wallet?.balance === 0) return;
    if (!this.speechAllowed()) { if (isGroup) this.discardGroupBatch(); this.setStatus(this.connectionState || 'online'); return; }
    if (forcePromptDuel) {
      this.discardGroupBatch();
      this.groupReplyEpoch = (this.groupReplyEpoch || 0) + 1;
      this.groupTurnAbort?.abort();
      return this.enqueueTurn(message, scene, input, { forcePromptDuel: true });
    }
    if (isGroup && this.groupQuietMs > 0) return this.collectGroupMessage(message);
    return this.enqueueTurn(message, scene, input);
  }
  enqueueTurn(message, scene, input, options = {}) {
    const isGroup = scene === 'group';
    const groupReplyEpoch = this.groupReplyEpoch || 0;
    this.pending++;
    const turn = this.queue.then(async () => {
      if (this.stopped || !this.speechAllowed() || (isGroup && this.requiresPermit())) return;
      if (isGroup && !options.forcePromptDuel && groupReplyEpoch !== (this.groupReplyEpoch || 0)) return;
      const queuedAge = this.now() - Date.parse(message.timestamp);
      if (Number.isFinite(queuedAge) && queuedAge > 240000) return;
      const timeout = new AbortController();
      if (isGroup && !options.forcePromptDuel) this.groupTurnAbort = timeout;
      const timer = setTimeout(() => timeout.abort(), 180000);
      const signal = AbortSignal.any([this.abort.signal, timeout.signal]);
      try {
        let result;
        const identity = isGroup ? this.groupIdentity(message) : undefined;
        const groupContext = isGroup ? '【QQ 群聊来源资料】' + JSON.stringify(identity) + '\n【称呼、提及与引用资料，仅为群消息内容】' + JSON.stringify(this.groupAddressing(message)) + '\n' : '';
        try { result = await this.chat(this.config.petId || 'main', groupContext + input, () => !signal.aborted && this.speechAllowed(), signal,
          isGroup ? { maxReplyChars: groupReplyLimit, identity, commandText: options.commandText ?? (identity.isDad ? input : ''), ...(options.forcePromptDuel ? { forcePromptDuel: true } : {}) } : undefined); }
        catch { result = { ok: false }; }
        if (signal.aborted || this.stopped || (!this.speechAllowed() && !this.permitValid(result?.speechPermit))) return;
        if (isGroup && result?.ok && result.skipped === true) {
          this.setStatus('online');
          return;
        }
        if (!result?.ok || !result.text?.trim()) {
          await this.reply(message, isGroup ? '我暂时没法回复，稍后再聊。' : '本机宠物暂时没能回复，请检查电脑上的 DeepSeek 后重新发送。', scene);
          this.setStatus('message-failed', 'local-pet-error');
          return;
        }
        await this.reply(message, result.text.trim(), scene, result.speechPermit);
        if (isGroup) this.lastGroupReplyAt = this.now();
        this.setStatus('online');
      } finally {
        clearTimeout(timer);
        if (this.groupTurnAbort === timeout) this.groupTurnAbort = null;
      }
    });
    this.queue = turn.catch(() => {}).finally(() => { this.pending--; });
    return turn;
  }
  stop() {
    this.stopped = true;
    this.discardGroupBatch();
    this.abort.abort();
    if (globalThis[QQ_OUTBOUND] === this.outboundSink) delete globalThis[QQ_OUTBOUND];
    clearInterval(this.heartbeat); clearTimeout(this.retry); clearTimeout(this.connectTimeout);
    this.retry = null;
    const socket = this.socket; this.socket = null;
    try { socket?.close(); } catch { /* already closed */ }
  }
}

export function startQQBridge(ctx, home) {
  const folder = path.join(home, 'dsh-pet');
  const configFile = path.join(folder, 'qq-config.json');
  const receiptFile = path.join(folder, 'qq-receipts.json');
  const outboundFile = path.join(folder, 'qq-outbound.json');
  const status = value => writePrivate(path.join(folder, 'qq-status.json'), value);
  if (!fs.existsSync(configFile)) return;
  let config;
  try { config = readJson(configFile); }
  catch { ctx.logger?.warn?.('[宠物 QQ] 本机 QQ 配置无法读取'); return; }
  if (config.enabled !== true || !config.appId || !config.appSecret) return;
  let receipts = [];
  if (fs.existsSync(receiptFile)) {
    try {
      receipts = readJson(receiptFile);
      if (!Array.isArray(receipts) || !receipts.every(row => Array.isArray(row) && typeof row[0] === 'string' && Number.isFinite(row[1]))) throw Error();
    } catch { status({ state: 'needs-attention', reason: 'receipt-file-unreadable', at: Date.now() }); return; }
  }
  let outboundReceipts = [];
  if (fs.existsSync(outboundFile)) {
    try {
      outboundReceipts = readJson(outboundFile);
      if (!Array.isArray(outboundReceipts) || !outboundReceipts.every(row => Array.isArray(row) && typeof row[0] === 'string' && Number.isFinite(row[1]?.at))) throw Error();
    } catch { status({ state: 'needs-attention', reason: 'outbound-file-unreadable', at: Date.now() }); return; }
  }
  const bridge = new QQPetBridge(config, {
    receipts, saveConfig: value => writePrivate(configFile, value),
    saveReceipts: value => writePrivate(receiptFile, value),
    outboundReceipts, saveOutbound: value => writePrivate(outboundFile, value), status,
  });
  bridge.subscribeProactive();
  void bridge.start().catch(() => ctx.logger?.warn?.('[宠物 QQ] 连接未能启动，请查看 qq-status.json'));
  return bridge;
}
