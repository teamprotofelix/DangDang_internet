// Local interaction receipts and presentation only. Never reads chat or page content.
(() => {
  class Client {
    constructor({
      controller,
      settings,
      controls,
      reaction = () => {},
      clear = () => {},
      management = null,
      send = (p) => chrome.runtime.sendMessage(p),
    }) {
      Object.assign(this, {
        controller,
        settings,
        controls,
        reaction,
        clear,
        management,
        send,
      });
      this.state = { enabled: false, epoch: null, revision: 0 };
      this.pending = new Map();
      this.client = PlayMemory.createId();
      this.sequence = 0;
      this.serial = 0;
      const start = controller.onInteractionStart,
        end = controller.onInteractionEnd;
      controller.onInteractionStart = (e) => {
        start(e);
        this.start(e);
      };
      controller.onInteractionEnd = (e) => {
        end(e);
        this.end(e);
      };
      this.listener = (msg) => {
        if (msg.type !== "play_memory_changed" || this.dead) return;
        this.accept(msg.data);
        if (this.management) this.refresh();
      };
      chrome.runtime.onMessage.addListener(this.listener);
      this.bindManagement();
      this.updatePolicy();
    }
    async rpc(type, data = {}) {
      try {
        return (await this.send({ type, data })) || { status: "error" };
      } catch (_) {
        return { status: "error" };
      }
    }
    accept(next) {
      if (
        this.dead ||
        !next ||
        typeof next.enabled !== "boolean" ||
        typeof next.epoch !== "string"
      )
        return;
      if (next.revision < this.state.revision) return;
      const invalidate =
        next.epoch !== this.state.epoch ||
        next.enabled !== this.state.enabled ||
        next.reason === "preference";
      if (invalidate) {
        this.serial++;
        if (
          next.epoch !== this.state.epoch ||
          next.enabled !== this.state.enabled
        )
          this.pending.clear();
        this.invalidate();
      }
      this.state = { ...this.state, ...next };
      this.updatePolicy();
      this.render();
    }
    invalidate() {
      this.controller.touchIntent();
      this.controls?.recommend(null);
      this.clear();
    }
    updatePolicy() {
      const s = this.settings() || {},
        key = [
          s.proactiveEnabled,
          s.speechBubblesEnabled,
          s.focusMode,
          s.floatingAvatarEnabled,
          s.poseCollapsed,
        ].join("|");
      if (this.policyKey !== undefined && this.policyKey !== key)
        this.invalidate();
      this.policyKey = key;
      this.controller.setPlayMemoryPolicy(
        this.state.enabled && !this.memoryBarrier,
        s.proactiveEnabled === true && !s.focusMode,
      );
    }
    async ready({ reunion = false } = {}) {
      await this.refresh();
      if (reunion) await this.requestReunion();
    }
    async refresh() {
      if (this.refreshing) {
        this.dirty = true;
        return this.refreshing;
      }
      this.refreshing = (async () => {
        do {
          this.dirty = false;
          const serial = this.serial,
            r = await this.rpc("pm_get");
          if (serial === this.serial && r.status === "ok") this.accept(r.state);
        } while (this.dirty && !this.dead);
      })();
      try {
        await this.refreshing;
      } finally {
        this.refreshing = null;
      }
    }
    start(e) {
      this.controls?.recommend(null);
      if (
        this.dead ||
        this.memoryBarrier ||
        !this.state.enabled ||
        !this.state.epoch
      )
        return;
      const at = Date.now(),
        eventId =
          "pm" + at.toString(36) + "_" + this.client + "_" + ++this.sequence,
        epoch = this.state.epoch;
      const entry = {
        eventId,
        epoch,
        at,
        intent: this.controller.intentVersion,
        serial: this.serial,
      };
      entry.begin = this.rpc("pm_begin", {
        epoch,
        action: e.name,
        eventId,
        at,
      });
      this.pending.set(e.kind + ":" + e.token, entry);
    }
    async end(e) {
      const key = e.kind + ":" + e.token,
        entry = this.pending.get(key);
      this.pending.delete(key);
      if (!entry) return;
      const begun = await entry.begin;
      if (begun.status !== "ok" || !begun.ticket) return;
      const result = await this.rpc("pm_end", {
        epoch: entry.epoch,
        eventId: entry.eventId,
        ticket: begun.ticket,
        completed: e.completed === true,
      });
      if (e.completed && result.status === "ok")
        this.present(result.reunion, entry);
    }
    async requestReunion() {
      const entry = {
        epoch: this.state.epoch,
        intent: this.controller.intentVersion,
        serial: this.serial,
      };
      if (!this.state.enabled) return;
      const r = await this.rpc("pm_reunion", { epoch: entry.epoch });
      if (r.status === "ok") this.present(r.reunion, entry);
    }
    present(reunion, entry) {
      const c = this.controller,
        s = this.settings() || {};
      if (
        this.dead ||
        this.saving ||
        !reunion ||
        !this.state.enabled ||
        reunion.epoch !== this.state.epoch ||
        entry.epoch !== this.state.epoch ||
        entry.serial !== this.serial ||
        entry.intent !== c.intentVersion ||
        !s.proactiveEnabled ||
        s.focusMode ||
        !c.active ||
        c.dead ||
        c.activeCommand ||
        c.busy.size ||
        c.temporary?.kind === "pet" ||
        ["dragging", "paused", "walk"].includes(c.behavior)
      )
        return false;
      if (!c.showReunion(reunion.source === "reunion_long" ? "aegyo" : "smile"))
        return false;
      this.controls?.recommend(reunion.suggestion);
      if (s.speechBubblesEnabled)
        this.reaction(
          CompanionPolicy.reaction(
            reunion.suggestion
              ? "suggest_" + reunion.suggestion
              : reunion.source,
            "pm-greeting-" + entry.epoch + "-" + Date.now(),
          ),
        );
      return true;
    }
    bindManagement() {
      const m = this.management;
      if (!m) return;
      m.querySelector("#toggle-play-memory").addEventListener("change", (e) =>
        this.control({ action: "enabled", enabled: e.target.checked }),
      );
      m.querySelector("#play-memory-preference").addEventListener(
        "change",
        (e) =>
          this.control({
            action: "preference",
            preference: e.target.value === "auto" ? null : e.target.value,
          }),
      );
      const confirm = m.querySelector("#play-memory-confirm");
      m.querySelector("#btn-reset-play-memory").addEventListener(
        "click",
        () => {
          confirm.hidden = false;
          m.querySelector("#btn-confirm-play-memory").focus();
        },
      );
      m.querySelector("#btn-cancel-play-memory").addEventListener(
        "click",
        () => {
          confirm.hidden = true;
          m.querySelector("#btn-reset-play-memory").focus();
        },
      );
      m.querySelector("#btn-confirm-play-memory").addEventListener(
        "click",
        async () => {
          await this.control({ action: "reset" });
          confirm.hidden = true;
          m.querySelector("#btn-reset-play-memory").focus();
        },
      );
    }
    async control(data) {
      if (this.saving) return;
      this.saving = true;
      this.memoryBarrier = data.action !== "preference";
      this.updatePolicy();
      // Stop pending presentations immediately; the worker independently guards storage.
      this.serial++;
      if (data.action !== "preference") this.pending.clear();
      this.invalidate();
      if (data.action === "enabled" && !data.enabled) {
        this.state.enabled = false;
        this.updatePolicy();
      }
      this.render();
      const result = await this.rpc("pm_control", data);
      if (result.status === "ok") this.accept(result.state);
      else await this.refresh();
      this.saving = false;
      this.memoryBarrier = false;
      this.updatePolicy();
      this.render();
      if (this.management)
        this.management.querySelector("#play-memory-status").textContent =
          result.status === "ok"
            ? data.action === "reset"
              ? "놀이 기억을 초기화했어요."
              : "놀이 기억 설정을 저장했어요."
            : "저장하지 못했어요. 다시 시도해 주세요.";
    }
    render() {
      const m = this.management,
        d = this.state;
      if (!m) return;
      for (const e of m.querySelectorAll("button,input,select"))
        e.disabled = this.saving || !d.epoch;
      m.querySelector("#toggle-play-memory").checked = d.enabled;
      m.querySelector("#play-memory-preference").value = d.preference || "auto";
      for (const action of Object.keys(PlayMemory.ACTIONS))
        m.querySelector('[data-play-count="' + action + '"]').textContent =
          String(d.counts?.[action] || 0);
      m.querySelector("#play-memory-last").textContent = !d.lastInteractionAt
        ? "아직 없음"
        : d.lastInteractionAt > Date.now()
          ? "기기 시각을 확인해 주세요"
          : new Date(d.lastInteractionAt).toLocaleString();
      const f = d.favorite;
      m.querySelector("#play-memory-favorite").textContent = f?.action
        ? (f.reason === "manual"
            ? "직접 고른 놀이: "
            : "최근 자주 고른 놀이: ") + PlayMemory.ACTIONS[f.action]
        : f?.reason === "disabled"
          ? "놀이 제안을 사용하지 않아요."
          : "기록이 더 쌓이면 자주 고른 놀이를 제안해요.";
    }
    destroy() {
      if (this.dead) return;
      this.dead = true;
      this.pending.clear();
      chrome.runtime.onMessage.removeListener(this.listener);
      this.invalidate();
    }
  }
  globalThis.PlayMemoryClient = { Client };
})();
