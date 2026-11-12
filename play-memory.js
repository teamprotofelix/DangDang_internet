// Local play-memory protocol/policy. Only the service worker instantiates Store.
(() => {
  const ACTIONS = Object.freeze({
    come: "이리 와",
    sit: "앉아",
    paw: "손",
    play: "공놀이",
    pet: "쓰다듬기",
  });
  const RULES = Object.freeze({
    version: 1,
    minTotal: 8,
    minWinner: 5,
    minLead: 2,
    reunionAfter: 30 * 60000,
    reunionGap: 4 * 3600000,
    longAbsence: 24 * 3600000,
    eventWindow: 60000,
    ticketTTL: 30000,
    receiptTTL: 120000,
    maxEvents: 512,
  });
  const KEY = "companion_play_memory";
  const validId = (x) =>
    typeof x === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{7,95}$/.test(x);
  const nonce = () =>
    globalThis.crypto?.randomUUID?.() ||
    (globalThis.crypto?.getRandomValues
      ? [...crypto.getRandomValues(new Uint8Array(16))]
          .map((x) => x.toString(16).padStart(2, "0"))
          .join("")
      : "pm" + Date.now().toString(36) + Math.random().toString(36).slice(2));
  const eventTime = (id) => {
    const m =
      typeof id === "string" &&
      /^pm([0-9a-z]+)_[A-Za-z0-9-]{8,50}_[0-9]{1,9}$/.exec(id);
    return m ? parseInt(m[1], 36) : NaN;
  };
  const number = (x) => (Number.isSafeInteger(x) && x >= 0 ? x : 0);
  function empty(id = nonce()) {
    return {
      version: 1,
      epoch: id,
      enabled: false,
      counts: Object.fromEntries(Object.keys(ACTIONS).map((k) => [k, 0])),
      lastInteractionAt: 0,
      preference: null,
      lastGreetingAt: 0,
      revision: 0,
      pending: {},
      seen: {},
    };
  }
  function normalize(raw, id = nonce()) {
    if (!raw || raw.version !== 1 || !validId(raw.epoch)) return empty(id);
    const d = empty(raw.epoch);
    d.enabled = raw.enabled === true;
    d.lastInteractionAt = number(raw.lastInteractionAt);
    d.lastGreetingAt = number(raw.lastGreetingAt);
    d.revision = number(raw.revision);
    for (const key of Object.keys(ACTIONS))
      d.counts[key] = number(raw.counts?.[key]);
    d.preference = Object.hasOwn(ACTIONS, raw.preference)
      ? raw.preference
      : raw.preference === "none"
        ? "none"
        : null;
    for (const [key, value] of Object.entries(raw.seen || {}).slice(
      0,
      RULES.maxEvents,
    ))
      if (validId(key) && number(value) > 0) d.seen[key] = value;
    for (const [key, p] of Object.entries(raw.pending || {}).slice(
      0,
      Math.max(0, RULES.maxEvents - Object.keys(d.seen).length),
    ))
      if (
        validId(key) &&
        p &&
        Object.hasOwn(ACTIONS, p.action) &&
        validId(p.ticket) &&
        typeof p.owner === "string" &&
        p.owner.length <= 160 &&
        number(p.at) > 0
      ) {
        d.pending[key] = {
          action: p.action,
          ticket: p.ticket,
          owner: p.owner,
          at: p.at,
          reunion:
            p.reunion && Object.hasOwn(ACTIONS, p.reunion.suggestion)
              ? {
                  source:
                    p.reunion.source === "reunion_long"
                      ? "reunion_long"
                      : "reunion",
                  suggestion: p.reunion.suggestion,
                }
              : p.reunion
                ? {
                    source:
                      p.reunion.source === "reunion_long"
                        ? "reunion_long"
                        : "reunion",
                    suggestion: null,
                  }
                : null,
        };
      }
    return d;
  }
  function favorite(d) {
    if (d.preference === "none") return { action: null, reason: "disabled" };
    if (Object.hasOwn(ACTIONS, d.preference))
      return { action: d.preference, reason: "manual" };
    const ranked = Object.keys(ACTIONS)
      .map((action) => ({ action, count: d.counts[action] }))
      .sort((a, b) => b.count - a.count);
    const total = ranked.reduce((n, x) => n + x.count, 0),
      winner = ranked[0];
    return total >= RULES.minTotal &&
      winner.count >= RULES.minWinner &&
      winner.count - ranked[1].count >= RULES.minLead
      ? { action: winner.action, reason: "observed" }
      : { action: null, reason: "insufficient" };
  }
  function summary(d, trusted = false) {
    const p = { enabled: d.enabled, epoch: d.epoch, revision: d.revision };
    return trusted
      ? {
          ...p,
          version: 1,
          counts: { ...d.counts },
          lastInteractionAt: d.lastInteractionAt,
          preference: d.preference,
          favorite: favorite(d),
        }
      : p;
  }
  function period(now = Date.now()) {
    const hour = new Date(now).getHours();
    return hour >= 22 || hour < 6 ? "late" : "day";
  }
  class Store {
    constructor({
      read,
      write,
      remove,
      settings,
      changed = () => {},
      now = () => Date.now(),
      id = nonce,
    }) {
      Object.assign(this, { read, write, remove, settings, changed, now, id });
      this.queue = Promise.resolve();
      this.generation = 0;
    }
    dispatch(type, p = {}, actor = {}) {
      const control = type === "pm_control";
      if (control && !actor.trusted)
        return Promise.resolve({ status: "denied" });
      if (control && !["enabled", "reset", "preference"].includes(p.action))
        return Promise.resolve({ status: "invalid" });
      if (control && p.action === "enabled" && typeof p.enabled !== "boolean")
        return Promise.resolve({ status: "invalid" });
      if (control && ["enabled", "reset"].includes(p.action)) this.generation++;
      const generation = this.generation;
      const task = this.queue.then(() =>
        this.execute(type, p, actor, generation),
      );
      this.queue = task.catch(() => {});
      return task;
    }
    async execute(type, p, actor, generation) {
      if (type !== "pm_control" && generation !== this.generation)
        return { status: "stale" };
      const raw = await this.read();
      if (type !== "pm_control" && generation !== this.generation)
        return { status: "stale" };
      const d = normalize(raw, this.id()),
        now = this.now();
      let changed = false,
        reunion = null,
        ticket = null;
      for (const [key, at] of Object.entries(d.seen))
        if (now >= at && now - at > RULES.receiptTTL) delete d.seen[key];
      for (const [key, value] of Object.entries(d.pending))
        if (now < value.at || now - value.at > RULES.ticketTTL) {
          d.seen[key] = now;
          delete d.pending[key];
        }
      const claim = async () => {
        if (
          !d.enabled ||
          !d.lastInteractionAt ||
          now < d.lastInteractionAt ||
          now - d.lastInteractionAt < RULES.reunionAfter ||
          now < d.lastGreetingAt ||
          (d.lastGreetingAt && now - d.lastGreetingAt < RULES.reunionGap)
        )
          return null;
        const s = await this.settings();
        if (
          !s.proactiveEnabled ||
          s.focusMode ||
          (actor.view === "floating"
            ? !s.floatingAvatarEnabled
            : s.poseCollapsed)
        )
          return null;
        d.lastGreetingAt = now;
        changed = true;
        return {
          source:
            now - d.lastInteractionAt >= RULES.longAbsence
              ? "reunion_long"
              : "reunion",
          suggestion: favorite(d).action,
        };
      };
      if (type === "pm_control") {
        if (p.action === "reset") {
          const enabled = d.enabled,
            revision = d.revision;
          Object.assign(d, empty(this.id()), { enabled, revision });
        }
        if (p.action === "enabled") {
          d.enabled = p.enabled;
          d.epoch = this.id();
          d.pending = {};
          d.seen = {};
        }
        if (p.action === "preference") {
          if (
            p.preference !== null &&
            p.preference !== "none" &&
            !Object.hasOwn(ACTIONS, p.preference)
          )
            return { status: "invalid" };
          d.preference = p.preference;
        }
        changed = true;
      } else if (type === "pm_get") {
        // A read restores sanitized defaults after missing/corrupt/old data.
      } else if (type === "pm_begin") {
        if (
          !d.enabled ||
          p.epoch !== d.epoch ||
          !Object.hasOwn(ACTIONS, p.action) ||
          !validId(p.eventId) ||
          !Number.isFinite(p.at) ||
          Math.abs(now - p.at) > RULES.eventWindow ||
          eventTime(p.eventId) !== p.at
        )
          return { status: "ignored" };
        if (
          Object.hasOwn(d.seen, p.eventId) ||
          Object.hasOwn(d.pending, p.eventId)
        )
          return { status: "duplicate" };
        if (
          Object.keys(d.pending).length + Object.keys(d.seen).length >=
          RULES.maxEvents
        )
          return { status: "busy" };
        reunion = await claim();
        ticket = this.id();
        d.pending[p.eventId] = {
          ticket,
          action: p.action,
          owner: actor.owner,
          at: now,
          reunion,
        };
        changed = true;
      } else if (type === "pm_end") {
        if (
          !d.enabled ||
          p.epoch !== d.epoch ||
          !validId(p.eventId) ||
          !Object.hasOwn(d.pending, p.eventId)
        )
          return { status: "ignored" };
        const pending = d.pending[p.eventId];
        if (pending.ticket !== p.ticket || pending.owner !== actor.owner)
          return { status: "denied" };
        delete d.pending[p.eventId];
        d.seen[p.eventId] = now;
        changed = true;
        if (p.completed === true) {
          d.counts[pending.action] = Math.min(
            Number.MAX_SAFE_INTEGER,
            d.counts[pending.action] + 1,
          );
          d.lastInteractionAt = now;
          if (d.lastGreetingAt > now) d.lastGreetingAt = 0;
          reunion = pending.reunion
            ? { source: pending.reunion.source, suggestion: favorite(d).action }
            : null;
        }
      } else if (type === "pm_reunion") {
        if (p.epoch !== d.epoch) return { status: "stale" };
        reunion = await claim();
      } else return { status: "invalid" };
      if (type !== "pm_control" && generation !== this.generation)
        return { status: "stale" };
      // This owner serializes ALL writes, including controls. If OFF/reset arrives
      // during a native write, restore the prior document before its queued control
      // executes. No other owner writes this key, so rollback cannot clobber newer data.
      const needsWrite = changed || JSON.stringify(raw) !== JSON.stringify(d);
      if (needsWrite) {
        d.revision = Math.min(Number.MAX_SAFE_INTEGER, d.revision + 1);
        await this.write(d);
        if (type !== "pm_control" && generation !== this.generation) {
          if (raw === undefined) await this.remove();
          else await this.write(raw);
          return { status: "stale" };
        }
        this.changed(
          summary(d),
          type === "pm_control"
            ? p.action
            : type === "pm_end"
              ? "record"
              : type === "pm_begin"
                ? "reservation"
                : type === "pm_reunion"
                  ? "reunion"
                  : "read",
        );
      }
      return {
        status: "ok",
        state: summary(d, actor.trusted),
        ticket,
        reunion: reunion ? { ...reunion, epoch: d.epoch } : null,
      };
    }
  }
  globalThis.PlayMemory = {
    ACTIONS,
    RULES,
    KEY,
    createId: nonce,
    empty,
    normalize,
    favorite,
    summary,
    period,
    Store,
  };
})();
