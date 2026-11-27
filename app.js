/**
 * 嶸鐿出差打卡系統 - LIFF 前端主程式 (app.js)
 * 單一 LIFF App 依 ?page= 切換頁面：checkin / makeup / draft / records
 * 每次呼叫 GAS 皆附帶 liff.getIDToken()，以 Content-Type: text/plain 避免 CORS 預檢
 */

(function () {
  'use strict';

  const state = {
    idToken: '',
    bootstrap: null,
    page: 'checkin',
    draftMonth: '',
    draftData: null,
    recordsYear: null,
    recordsData: null,
    geo: { status: 'loading', value: '', text: '正在取得位置…' },
    selectedCompanions: [], // [{ lineId, name, clockForThem }]
    elapsedTimer: null,
  };

  const $main = () => document.getElementById('main-content');
  const $topBar = () => document.getElementById('top-bar');
  const $userBadge = () => document.getElementById('user-badge');
  const $bottomNav = () => document.getElementById('bottom-nav');
  const $modalBackdrop = () => document.getElementById('modal-backdrop');
  const $modalSheet = () => document.getElementById('modal-sheet');

  // ==========================================================================
  // 啟動流程
  // ==========================================================================

  async function init() {
    bindGlobalEvents();
    const cfg = window.APP_CONFIG || {};
    if (!cfg.LIFF_ID || !cfg.GAS_WEB_APP_URL) {
      renderFatalError(
        '系統尚未完成前端設定',
        '請管理者在 config.js 填入 LIFF_ID 與 GAS_WEB_APP_URL 後重新整理。'
      );
      return;
    }

    // 讀取網址參數 ?page= 與 ?month=
    const params = new URLSearchParams(window.location.search);
    const reqPage = params.get('page');
    if (['checkin', 'makeup', 'draft', 'records'].includes(reqPage)) {
      state.page = reqPage;
    }
    if (params.get('month')) {
      state.draftMonth = params.get('month');
    }

    try {
      await liff.init({ liffId: cfg.LIFF_ID });
      if (!liff.isLoggedIn()) {
        liff.login({ redirectUri: window.location.href });
        return;
      }

      state.idToken = liff.getIDToken();
      if (!state.idToken) {
        renderFatalError(
          '無法取得 LINE 驗證憑證',
          '請確認 LIFF App 的 Scope 已勾選 openid 與 profile，並從 LINE 重新開啟。'
        );
        return;
      }

      await reloadBootstrap();
      routeAndRender();
    } catch (err) {
      renderFatalError('初始化失敗', err && err.message ? err.message : '請關閉頁面後從 LINE 重新開啟。');
    }
  }

  function bindGlobalEvents() {
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const target = btn.getAttribute('data-page');
        navigateTo(target);
      });
    });

    $modalBackdrop().addEventListener('click', (e) => {
      if (e.target === $modalBackdrop()) {
        closeModal();
      }
    });
  }

  async function reloadBootstrap() {
    const data = await callGas('getBootstrap', {});
    state.bootstrap = data;
    if (!state.draftMonth && data.defaultDraftMonth) {
      state.draftMonth = data.defaultDraftMonth;
    }
  }

  // ==========================================================================
  // API 呼叫（Content-Type: text/plain 避免 CORS 預檢）
  // ==========================================================================

  async function callGas(action, payload) {
    const url = window.APP_CONFIG.GAS_WEB_APP_URL;
    // 每次呼叫前重新取得 ID Token（LIFF 開著很久時，舊的 Token 可能已過期）
    try {
      const fresh = liff.getIDToken();
      if (fresh) state.idToken = fresh;
    } catch (e) { /* 取不到就沿用舊的 */ }
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8',
      },
      body: JSON.stringify({
        source: 'liff',
        action,
        idToken: state.idToken,
        payload: payload || {},
      }),
      redirect: 'follow',
    });

    if (!res.ok) {
      throw new Error(`伺服器連線失敗（HTTP ${res.status}）`);
    }

    const json = await res.json();
    if (!json || !json.ok) {
      if (json && json.code === 'TOKEN_EXPIRED') {
        handleTokenExpired();
      }
      const err = new Error((json && json.error) || '系統發生錯誤，請稍後再試');
      err.code = json && json.code ? json.code : 'ERROR';
      throw err;
    }
    clearReauthFlag();
    return json.data;
  }

  // 登入逾時：第一次先重新整理頁面；重新整理後仍逾時，才重新走 LINE 登入，避免無限重整
  const REAUTH_KEY = 'ronyi_trip_reauth';

  function handleTokenExpired() {
    let tried = false;
    try { tried = sessionStorage.getItem(REAUTH_KEY) === '1'; } catch (e) { /* 部分環境不支援 */ }
    showToast('登入逾時，已重新連線，請再按一次', 'error');
    setTimeout(() => {
      if (!tried) {
        try { sessionStorage.setItem(REAUTH_KEY, '1'); } catch (e) { /* ignore */ }
        window.location.reload();
      } else {
        try { sessionStorage.removeItem(REAUTH_KEY); } catch (e) { /* ignore */ }
        try { liff.logout(); } catch (e) { /* ignore */ }
        liff.login({ redirectUri: window.location.href });
      }
    }, 1200);
  }

  function clearReauthFlag() {
    try { sessionStorage.removeItem(REAUTH_KEY); } catch (e) { /* ignore */ }
  }

  // ==========================================================================
  // 路由與共用介面
  // ==========================================================================

  function navigateTo(page, opts) {
    stopElapsedTimer();
    state.page = page;
    if (opts && opts.month) {
      state.draftMonth = opts.month;
    }
    const url = new URL(window.location.href);
    url.searchParams.set('page', page);
    if (page === 'draft' && state.draftMonth) {
      url.searchParams.set('month', state.draftMonth);
    } else {
      url.searchParams.delete('month');
    }
    window.history.replaceState({}, '', url.toString());
    routeAndRender();
  }

  function routeAndRender() {
    const b = state.bootstrap;
    if (!b) return;

    if (b.accountStatus === 'NOT_REGISTERED') {
      $topBar().classList.remove('hidden');
      $userBadge().textContent = '首次註冊';
      $bottomNav().classList.add('hidden');
      renderRegisterPage();
      return;
    }

    if (b.accountStatus === 'DISABLED') {
      $topBar().classList.remove('hidden');
      $userBadge().textContent = b.employee ? b.employee.name : '已停用';
      $bottomNav().classList.add('hidden');
      renderDisabledPage();
      return;
    }

    // 啟用中員工
    $topBar().classList.remove('hidden');
    $userBadge().textContent = `${b.employee.name}・${b.employee.title}`;
    $bottomNav().classList.remove('hidden');
    updateBottomNavActive();

    if (state.page === 'makeup') {
      renderMakeupPage();
    } else if (state.page === 'draft') {
      renderDraftPage();
    } else if (state.page === 'records') {
      renderRecordsPage();
    } else {
      if (b.activeTrip) {
        renderActiveTripPage();
      } else {
        renderDeparturePage();
      }
    }
  }

  function updateBottomNavActive() {
    const activeTab = state.page === 'makeup' ? 'checkin' : state.page;
    document.querySelectorAll('.nav-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-page') === activeTab);
    });
  }

  // ==========================================================================
  // 地理位置（失敗或拒絕仍可打卡，位置留空）
  // ==========================================================================

  function requestGeoLocation(onUpdate) {
    state.geo = { status: 'loading', value: '', text: '正在取得目前位置…' };
    if (onUpdate) onUpdate();

    if (!navigator.geolocation) {
      state.geo = { status: 'warn', value: '', text: '未取得位置（裝置不支援定位，仍可正常打卡）' };
      if (onUpdate) onUpdate();
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = Number(pos.coords.latitude).toFixed(5).replace(/\.?0+$/, '');
        const lng = Number(pos.coords.longitude).toFixed(5).replace(/\.?0+$/, '');
        state.geo = { status: 'ok', value: `${lat},${lng}`, text: `已取得位置（${lat}, ${lng}）` };
        if (onUpdate) onUpdate();
      },
      () => {
        state.geo = { status: 'warn', value: '', text: '未取得位置（可照常打卡）' };
        if (onUpdate) onUpdate();
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    );
  }

  function renderGeoBarHtml() {
    const cls = state.geo.status === 'ok' ? 'ok' : (state.geo.status === 'warn' ? 'warn' : '');
    const icon = state.geo.status === 'ok' ? '📍' : (state.geo.status === 'warn' ? '⚠️' : '⏳');
    return `
      <div id="geo-bar" class="geo-bar ${cls}">
        <span>${icon} ${esc(state.geo.text)}</span>
        <button type="button" id="btn-retry-geo" class="btn btn-ghost btn-sm" style="min-height:36px;padding:4px 10px;font-size:13px;">重抓</button>
      </div>
    `;
  }

  // ==========================================================================
  // 頁面 1：首次註冊頁
  // ==========================================================================

  function renderRegisterPage() {
    const b = state.bootstrap;
    const titles = (b.options && b.options.titles) || ['工程師', '會計'];
    let selectedTitle = '';
    let isOther = false;

    $main().innerHTML = `
      <div class="card">
        <h1 class="page-title">歡迎使用嶸鐿出差打卡</h1>
        <p style="color:var(--text-muted);margin-top:0;">第一次使用請填寫您的姓名與職位，完成後即可開始打卡。</p>

        <div class="field">
          <label class="section-label" for="reg-name">姓名<span class="required-star">*</span></label>
          <input id="reg-name" class="input" type="text" placeholder="請輸入真實姓名" value="${esc(b.lineDisplayName || '')}" />
          <div id="err-reg-name" class="field-error hidden"></div>
        </div>

        <div class="field">
          <span class="section-label">職位<span class="required-star">*</span></span>
          <div id="reg-title-chips" class="chip-group">
            ${titles.map((t) => `<button type="button" class="chip-btn" data-title="${esc(t)}">${esc(t)}</button>`).join('')}
            <button type="button" class="chip-btn" data-title="__OTHER__">其他</button>
          </div>
          <input id="reg-title-other" class="input hidden" style="margin-top:10px;" type="text" placeholder="請輸入您的職位名稱" />
          <div id="err-reg-title" class="field-error hidden"></div>
        </div>

        <button type="button" id="btn-register-submit" class="btn btn-primary btn-block btn-lg">完成註冊</button>
      </div>
    `;

    const otherInput = document.getElementById('reg-title-other');
    document.querySelectorAll('#reg-title-chips .chip-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#reg-title-chips .chip-btn').forEach((x) => x.classList.remove('selected'));
        btn.classList.add('selected');
        const val = btn.getAttribute('data-title');
        if (val === '__OTHER__') {
          isOther = true;
          selectedTitle = '';
          otherInput.classList.remove('hidden');
          otherInput.focus();
        } else {
          isOther = false;
          selectedTitle = val;
          otherInput.classList.add('hidden');
        }
        clearFieldError('reg-title');
      });
    });

    document.getElementById('btn-register-submit').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const name = document.getElementById('reg-name').value.trim();
      const finalTitle = isOther ? otherInput.value.trim() : selectedTitle;
      let valid = true;

      if (!name) {
        showFieldError('reg-name', '請輸入姓名');
        valid = false;
      } else {
        clearFieldError('reg-name');
      }

      if (!finalTitle) {
        showFieldError('reg-title', '請選擇或輸入職位');
        valid = false;
      } else {
        clearFieldError('reg-title');
      }

      if (!valid) return;

      btn.disabled = true;
      btn.textContent = '註冊中…';
      try {
        await callGas('register', {
          name,
          title: finalTitle,
          isCustomTitle: isOther,
        });
        showToast('註冊完成！', 'success');
        await reloadBootstrap();
        routeAndRender();
      } catch (err) {
        if (err.code === 'NOT_FRIEND') {
          renderNotFriendPage();
          return;
        }
        showToast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = '完成註冊';
      }
    });
  }

  // 尚未加入官方帳號好友（後端註冊時檢查）
  function renderNotFriendPage() {
    $main().innerHTML = `
      <div class="card" style="text-align:center;padding:40px 20px;">
        <div style="font-size:48px;margin-bottom:12px;">👋</div>
        <h1 class="page-title" style="justify-content:center;">請先加入官方帳號好友</h1>
        <p style="font-size:17px;color:var(--text-muted);margin:8px 0 16px;line-height:1.7;">
          在 LINE 搜尋「嶸鐿出差打卡」官方帳號並加入好友，<br />再關閉此頁面重新開啟即可註冊。
        </p>
        <button type="button" id="btn-close-liff" class="btn btn-primary btn-block btn-lg">關閉頁面</button>
      </div>
    `;
    const closeBtn = document.getElementById('btn-close-liff');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        try { liff.closeWindow(); } catch (e) { /* 外部瀏覽器無法關閉 */ }
      });
    }
  }

  // ==========================================================================
  // 頁面 2：帳號停用頁
  // ==========================================================================

  function renderDisabledPage() {
    $main().innerHTML = `
      <div class="card" style="text-align:center;padding:40px 20px;">
        <div style="font-size:48px;margin-bottom:12px;">🚫</div>
        <h1 class="page-title" style="justify-content:center;">帳號已停用</h1>
        <p style="font-size:17px;color:var(--text-muted);margin:8px 0 0;">帳號已停用，請聯絡管理者。</p>
      </div>
    `;
  }

  // ==========================================================================
  // 頁面 3：出發打卡頁
  // ==========================================================================

  function renderDeparturePage() {
    const b = state.bootstrap;
    const transports = (b.options && b.options.transports) || [];
    const otherEmployees = (b.activeEmployees || []).filter((e) => e.lineId !== b.employee.lineId);
    state.selectedCompanions = [];

    const selectedTransports = new Set();
    let otherTransportOn = false;

    $main().innerHTML = `
      <div class="card">
        <h1 class="page-title">出發打卡</h1>
        <div id="geo-slot">${renderGeoBarHtml()}</div>

        <div class="field">
          <label class="section-label" for="dep-location">地點／客戶<span class="required-star">*</span></label>
          <input id="dep-location" class="input" type="text" placeholder="例如：台中精機、友達光電中科廠" />
          <div id="err-dep-location" class="field-error hidden"></div>
        </div>

        <div class="field">
          <label class="section-label" for="dep-purpose">擬辦事項<span class="required-star">*</span></label>
          <textarea id="dep-purpose" class="textarea" placeholder="例如：設備安裝調機、技術支援"></textarea>
          <div id="err-dep-purpose" class="field-error hidden"></div>
        </div>

        <div class="field">
          <span class="section-label">交通工具（可複選）<span class="required-star">*</span></span>
          <div id="dep-transport-chips" class="chip-group">
            ${transports.map((t) => `<button type="button" class="chip-btn" data-val="${esc(t)}">${esc(t)}</button>`).join('')}
            <button type="button" class="chip-btn" data-val="__OTHER__">其他</button>
          </div>
          <input id="dep-transport-other" class="input hidden" style="margin-top:10px;" type="text" placeholder="請輸入其他交通工具（僅存這一筆）" />
          <div id="err-dep-transport" class="field-error hidden"></div>
        </div>

        <div class="field">
          <span class="section-label">同行人員（選填）</span>
          <div id="dep-companions-list"></div>
          <button type="button" id="btn-add-companion" class="btn btn-outline btn-sm">＋ 新增同行</button>
        </div>

        <div class="field">
          <label class="section-label" for="dep-deputy">代理人（選填）</label>
          <select id="dep-deputy" class="select">
            <option value="">（不指定）</option>
            ${otherEmployees.map((e) => `<option value="${esc(e.name)}">${esc(e.name)}（${esc(e.title)}）</option>`).join('')}
          </select>
        </div>

        <button type="button" id="btn-depart-submit" class="btn btn-primary btn-block btn-lg">🚀 出發打卡</button>

        <div style="text-align:center;margin-top:12px;">
          <button type="button" id="btn-go-makeup" class="link-btn">忘記打卡？補打卡</button>
        </div>
      </div>
    `;

    // 定位更新
    const updateGeoUi = () => {
      const slot = document.getElementById('geo-slot');
      if (!slot) return;
      slot.innerHTML = renderGeoBarHtml();
      const retry = document.getElementById('btn-retry-geo');
      if (retry) retry.addEventListener('click', () => requestGeoLocation(updateGeoUi));
    };
    requestGeoLocation(updateGeoUi);

    // 交通工具複選
    const otherInput = document.getElementById('dep-transport-other');
    document.querySelectorAll('#dep-transport-chips .chip-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const val = btn.getAttribute('data-val');
        if (val === '__OTHER__') {
          otherTransportOn = !otherTransportOn;
          btn.classList.toggle('selected', otherTransportOn);
          otherInput.classList.toggle('hidden', !otherTransportOn);
          if (otherTransportOn) otherInput.focus();
        } else {
          if (selectedTransports.has(val)) {
            selectedTransports.delete(val);
            btn.classList.remove('selected');
          } else {
            selectedTransports.add(val);
            btn.classList.add('selected');
          }
        }
        clearFieldError('dep-transport');
      });
    });

    // 同行人員清單
    const renderCompanions = () => {
      const box = document.getElementById('dep-companions-list');
      if (!box) return;
      if (state.selectedCompanions.length === 0) {
        box.innerHTML = '';
        return;
      }
      box.innerHTML = state.selectedCompanions.map((c, idx) => `
        <div class="companion-item">
          <div>
            <div style="font-weight:700;font-size:16px;">${esc(c.name)}</div>
            <label class="checkbox-label" style="min-height:36px;font-size:15px;">
              <input type="checkbox" data-comp-idx="${idx}" ${c.clockForThem ? 'checked' : ''} />
              <span>幫他打卡</span>
            </label>
          </div>
          <button type="button" class="btn btn-ghost btn-sm" data-remove-comp="${idx}">移除</button>
        </div>
      `).join('');

      box.querySelectorAll('input[data-comp-idx]').forEach((cb) => {
        cb.addEventListener('change', () => {
          const i = Number(cb.getAttribute('data-comp-idx'));
          state.selectedCompanions[i].clockForThem = cb.checked;
        });
      });
      box.querySelectorAll('button[data-remove-comp]').forEach((rm) => {
        rm.addEventListener('click', () => {
          const i = Number(rm.getAttribute('data-remove-comp'));
          state.selectedCompanions.splice(i, 1);
          renderCompanions();
        });
      });
    };

    document.getElementById('btn-add-companion').addEventListener('click', () => {
      openCompanionPickerModal(otherEmployees, renderCompanions);
    });

    document.getElementById('btn-go-makeup').addEventListener('click', () => navigateTo('makeup'));

    // 送出出發打卡
    document.getElementById('btn-depart-submit').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const location = document.getElementById('dep-location').value.trim();
      const purpose = document.getElementById('dep-purpose').value.trim();
      const deputy = document.getElementById('dep-deputy').value.trim();

      const tList = Array.from(selectedTransports);
      if (otherTransportOn) {
        const custom = otherInput.value.trim();
        if (custom) tList.push(custom);
      }
      const transport = tList.join('、');

      let valid = true;
      if (!location) {
        showFieldError('dep-location', '請填寫地點／客戶');
        valid = false;
      } else {
        clearFieldError('dep-location');
      }
      if (!purpose) {
        showFieldError('dep-purpose', '請填寫擬辦事項');
        valid = false;
      } else {
        clearFieldError('dep-purpose');
      }
      if (!transport) {
        showFieldError('dep-transport', '請至少選擇一項交通工具');
        valid = false;
      } else {
        clearFieldError('dep-transport');
      }
      if (!valid) return;

      btn.disabled = true;
      btn.textContent = '打卡送出中…';
      try {
        const result = await callGas('clockOutStart', {
          location,
          purpose,
          transport,
          deputy,
          geoLocation: state.geo.value,
          companions: state.selectedCompanions,
        });

        let msg = `出發打卡成功！（${result.startTime}）`;
        if (result.createdCompanionNames && result.createdCompanionNames.length > 0) {
          msg += `\n已代建同行：${result.createdCompanionNames.join('、')}`;
        }
        if (result.skippedNotices && result.skippedNotices.length > 0) {
          alert(`${msg}\n\n注意：\n${result.skippedNotices.join('\n')}`);
        } else {
          showToast(msg, 'success');
        }

        await reloadBootstrap();
        routeAndRender();
      } catch (err) {
        if (err.code === 'ALREADY_ACTIVE') {
          if (confirm(`${err.message}\n\n要前往補打卡頁補打返回卡嗎？`)) {
            navigateTo('makeup');
            return;
          }
        } else {
          showToast(err.message, 'error');
        }
        btn.disabled = false;
        btn.textContent = '🚀 出發打卡';
      }
    });
  }

  function openCompanionPickerModal(otherEmployees, onDone) {
    const selectedIds = new Set(state.selectedCompanions.map((c) => c.lineId));
    const available = otherEmployees.filter((e) => !selectedIds.has(e.lineId));

    openModal(`
      <div class="modal-head">
        <h2 class="modal-title">選擇同行人員</h2>
        <button type="button" class="modal-close" id="btn-modal-x">✕</button>
      </div>
      ${available.length === 0
        ? '<p class="empty-state">目前沒有其他可加入的啟用員工。</p>'
        : available.map((e) => `
          <label class="checkbox-label" style="border-bottom:1px solid #f1f5f9;padding:8px 4px;">
            <input type="checkbox" class="pick-emp-cb" value="${esc(e.lineId)}" data-name="${esc(e.name)}" />
            <span><strong>${esc(e.name)}</strong>（${esc(e.title)}）</span>
          </label>
        `).join('')
      }
      <div style="margin-top:16px;">
        <button type="button" id="btn-confirm-pick" class="btn btn-primary btn-block">加入同行人員</button>
      </div>
    `);

    document.getElementById('btn-modal-x').addEventListener('click', closeModal);
    document.getElementById('btn-confirm-pick').addEventListener('click', () => {
      document.querySelectorAll('.pick-emp-cb:checked').forEach((cb) => {
        state.selectedCompanions.push({
          lineId: cb.value,
          name: cb.getAttribute('data-name'),
          clockForThem: true, // 預設勾選「幫他打卡」
        });
      });
      closeModal();
      if (onDone) onDone();
    });
  }

  // ==========================================================================
  // 頁面 4：出差中頁（含跨日出差「暫停返回提醒」開關）
  // ==========================================================================

  function renderActiveTripPage() {
    const b = state.bootstrap;
    const t = b.activeTrip;
    const companions = b.activeCompanions || [];
    const isPaused = t.pauseReminder === '是';

    $main().innerHTML = `
      <div class="elapsed-banner">
        <div class="elapsed-label">出差進行中・已出差時間</div>
        <div id="elapsed-text" class="elapsed-value">${formatElapsed(t.startTime)}</div>
      </div>

      <div class="card">
        <div class="page-title" style="margin-bottom:14px;">
          <span>${esc(t.location)}</span>
          <span class="badge badge-active">出差中</span>
        </div>

        <div class="info-grid">
          <div class="info-row"><div class="info-key">出發時間</div><div class="info-val">${esc(t.startTime)}</div></div>
          <div class="info-row"><div class="info-key">擬辦事項</div><div class="info-val">${esc(t.purpose)}</div></div>
          <div class="info-row"><div class="info-key">交通工具</div><div class="info-val">${esc(t.transport)}</div></div>
          <div class="info-row"><div class="info-key">同行人員</div><div class="info-val">${esc(t.companions || '無')}</div></div>
          <div class="info-row"><div class="info-key">代理人</div><div class="info-val">${esc(t.deputy || '無')}</div></div>
        </div>

        <!-- 跨日出差（暫停返回提醒）開關 -->
        <div class="toggle-card">
          <div>
            <div class="toggle-title">跨日出差（暫停返回提醒）</div>
            <div class="toggle-desc">開啟後，每天 20:00 系統將跳過這趟的返回提醒，直到返回為止。</div>
          </div>
          <label class="switch" aria-label="跨日出差暫停返回提醒">
            <input type="checkbox" id="toggle-pause-reminder" ${isPaused ? 'checked' : ''} />
            <span class="slider"></span>
          </label>
        </div>

        <div class="btn-row" style="margin-bottom:16px;">
          <button type="button" id="btn-edit-active" class="btn btn-outline btn-sm">✏️ 修改這趟內容</button>
          <button type="button" id="btn-void-active" class="btn btn-outline-danger btn-sm">🗑️ 打錯了，作廢這趟</button>
        </div>

        <div id="geo-slot">${renderGeoBarHtml()}</div>

        ${companions.length > 0 ? `
          <div class="card" style="background:#f8fafc;margin-bottom:14px;padding:14px;">
            <div class="section-label">同行的人也一起返回嗎？</div>
            ${companions.map((c) => `
              <label class="checkbox-label">
                <input type="checkbox" class="return-comp-cb" value="${esc(c.recordId)}" checked />
                <span>${esc(c.name)}</span>
              </label>
            `).join('')}
          </div>
        ` : ''}

        <button type="button" id="btn-return-submit" class="btn btn-accent btn-block btn-lg">🏁 返回打卡</button>
      </div>
    `;

    // 即時更新已出差時間
    stopElapsedTimer();
    state.elapsedTimer = setInterval(() => {
      const el = document.getElementById('elapsed-text');
      if (el) el.textContent = formatElapsed(t.startTime);
    }, 30000);

    // 定位
    const updateGeoUi = () => {
      const slot = document.getElementById('geo-slot');
      if (!slot) return;
      slot.innerHTML = renderGeoBarHtml();
      const retry = document.getElementById('btn-retry-geo');
      if (retry) retry.addEventListener('click', () => requestGeoLocation(updateGeoUi));
    };
    requestGeoLocation(updateGeoUi);

    // 切換暫停提醒開關
    const pauseToggle = document.getElementById('toggle-pause-reminder');
    pauseToggle.addEventListener('change', async () => {
      const wantPaused = pauseToggle.checked;
      pauseToggle.disabled = true;
      try {
        await callGas('togglePauseReminder', {
          recordId: t.recordId,
          paused: wantPaused,
        });
        t.pauseReminder = wantPaused ? '是' : '';
        showToast(wantPaused ? '已開啟「跨日出差暫停提醒」' : '已恢復 20:00 返回提醒', 'success');
      } catch (err) {
        pauseToggle.checked = !wantPaused;
        showToast(err.message, 'error');
      } finally {
        pauseToggle.disabled = false;
      }
    });

    // 修改這趟內容
    document.getElementById('btn-edit-active').addEventListener('click', () => {
      openEditTripModal(t, async () => {
        await reloadBootstrap();
        routeAndRender();
      });
    });

    // 作廢這趟
    document.getElementById('btn-void-active').addEventListener('click', async () => {
      if (!confirm(`確定要作廢這趟「${t.location}」的出差紀錄嗎？（作廢後不列入月報）`)) {
        return;
      }
      try {
        await callGas('voidTrip', { recordId: t.recordId });
        showToast('已作廢該趟出差紀錄', 'success');
        await reloadBootstrap();
        routeAndRender();
      } catch (err) {
        showToast(err.message, 'error');
      }
    });

    // 返回打卡
    document.getElementById('btn-return-submit').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const companionRecordIds = Array.from(document.querySelectorAll('.return-comp-cb:checked'))
        .map((cb) => cb.value);

      btn.disabled = true;
      btn.textContent = '返回打卡中…';
      try {
        const res = await callGas('clockInReturn', {
          recordId: t.recordId,
          geoLocation: state.geo.value,
          companionRecordIds,
        });
        let msg = `返回打卡完成！（${res.endTime}）`;
        if (res.returnedCompanions && res.returnedCompanions.length > 0) {
          msg += `，同行 ${res.returnedCompanions.join('、')} 已一併返回`;
        }
        showToast(msg, 'success');
        await reloadBootstrap();
        routeAndRender();
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = '🏁 返回打卡';
      }
    });
  }

  function stopElapsedTimer() {
    if (state.elapsedTimer) {
      clearInterval(state.elapsedTimer);
      state.elapsedTimer = null;
    }
  }

  function formatElapsed(startTimeStr) {
    const dt = parseLocalDateTime(startTimeStr);
    if (!dt) return '計算中…';
    const diffMin = Math.max(0, Math.floor((Date.now() - dt.getTime()) / 60000));
    const days = Math.floor(diffMin / 1440);
    const hours = Math.floor((diffMin % 1440) / 60);
    const mins = diffMin % 60;
    if (days > 0) return `${days} 天 ${hours} 小時 ${mins} 分`;
    if (hours > 0) return `${hours} 小時 ${mins} 分`;
    return `${mins} 分鐘`;
  }

  // ==========================================================================
  // 頁面 5：補打卡頁
  // ==========================================================================

  function renderMakeupPage() {
    const b = state.bootstrap;
    const activeTrip = b.activeTrip;
    const transports = (b.options && b.options.transports) || [];
    const otherEmployees = (b.activeEmployees || []).filter((e) => e.lineId !== b.employee.lineId);

    let mode = activeTrip ? 'return' : 'start';
    const todayDate = getTodayDateInput();

    const renderModeBody = () => {
      const container = document.getElementById('makeup-body');
      if (!container) return;

      document.querySelectorAll('.makeup-mode-tab').forEach((tab) => {
        tab.classList.toggle('active', tab.getAttribute('data-mode') === mode);
      });

      if (mode === 'return') {
        if (!activeTrip) {
          container.innerHTML = `
            <div class="empty-state">
              目前沒有尚未返回的出差紀錄。<br/>如需補登整趟出差，請切換到「補出發」。
            </div>
          `;
          return;
        }
        container.innerHTML = `
          <div class="notice-box">
            <strong>補返回對象：</strong>${esc(activeTrip.location)}<br/>
            出發時間：${esc(activeTrip.startTime)}
          </div>
          <div class="field">
            <span class="section-label">返回日期與時間<span class="required-star">*</span></span>
            <div class="datetime-grid">
              <input id="mk-ret-date" class="input" type="date" value="${todayDate}" />
              <input id="mk-ret-time" class="input" type="time" value="17:30" />
            </div>
            <div id="err-mk-ret-time" class="field-error hidden"></div>
          </div>
          <div class="field">
            <label class="section-label" for="mk-ret-reason">補打原因<span class="required-star">*</span></label>
            <input id="mk-ret-reason" class="input" type="text" placeholder="例如：忘記打卡、手機沒電" />
            <div id="err-mk-ret-reason" class="field-error hidden"></div>
          </div>
          <button type="button" id="btn-mk-ret-submit" class="btn btn-primary btn-block btn-lg">送出補打返回</button>
        `;

        document.getElementById('btn-mk-ret-submit').addEventListener('click', async (e) => {
          const btn = e.currentTarget;
          const d = document.getElementById('mk-ret-date').value;
          const t = document.getElementById('mk-ret-time').value;
          const reason = document.getElementById('mk-ret-reason').value.trim();
          let valid = true;

          if (!d || !t) {
            showFieldError('mk-ret-time', '請填寫返回日期與時間');
            valid = false;
          } else {
            const endDt = parseLocalDateTime(`${d} ${t}`);
            const startDt = parseLocalDateTime(activeTrip.startTime);
            if (startDt && endDt && endDt.getTime() < startDt.getTime()) {
              showFieldError('mk-ret-time', '返回時間不可早於出發時間');
              valid = false;
            } else {
              clearFieldError('mk-ret-time');
            }
          }
          if (!reason) {
            showFieldError('mk-ret-reason', '請填寫補打原因');
            valid = false;
          } else {
            clearFieldError('mk-ret-reason');
          }
          if (!valid) return;

          btn.disabled = true;
          btn.textContent = '送出中…';
          try {
            await callGas('makeupTrip', {
              mode: 'return',
              recordId: activeTrip.recordId,
              endTime: `${d} ${t}`,
              reason,
            });
            showToast('補打返回卡成功！', 'success');
            await reloadBootstrap();
            navigateTo('checkin');
          } catch (err) {
            showToast(err.message, 'error');
            btn.disabled = false;
            btn.textContent = '送出補打返回';
          }
        });
        return;
      }

      // 模式：補出發（可同時填返回時間；不做同行代建）
      const selectedTransports = new Set();
      let otherOn = false;

      container.innerHTML = `
        <div class="field">
          <span class="section-label">出發日期與時間<span class="required-star">*</span></span>
          <div class="datetime-grid">
            <input id="mk-st-date" class="input" type="date" value="${todayDate}" />
            <input id="mk-st-time" class="input" type="time" value="08:30" />
          </div>
          <div id="err-mk-st-time" class="field-error hidden"></div>
        </div>

        <div class="field">
          <label class="checkbox-label">
            <input type="checkbox" id="mk-has-end" checked />
            <span>同時補填返回時間（補登記為「出發+返回」）</span>
          </label>
          <div id="mk-end-group" class="datetime-grid" style="margin-top:8px;">
            <input id="mk-en-date" class="input" type="date" value="${todayDate}" />
            <input id="mk-en-time" class="input" type="time" value="17:30" />
          </div>
          <div id="err-mk-en-time" class="field-error hidden"></div>
        </div>

        <div class="field">
          <label class="section-label" for="mk-location">地點／客戶<span class="required-star">*</span></label>
          <input id="mk-location" class="input" type="text" placeholder="請輸入地點或客戶名稱" />
          <div id="err-mk-location" class="field-error hidden"></div>
        </div>

        <div class="field">
          <label class="section-label" for="mk-purpose">擬辦事項<span class="required-star">*</span></label>
          <textarea id="mk-purpose" class="textarea" placeholder="請輸入擬辦事項"></textarea>
          <div id="err-mk-purpose" class="field-error hidden"></div>
        </div>

        <div class="field">
          <span class="section-label">交通工具（可複選）<span class="required-star">*</span></span>
          <div id="mk-transport-chips" class="chip-group">
            ${transports.map((t) => `<button type="button" class="chip-btn" data-val="${esc(t)}">${esc(t)}</button>`).join('')}
            <button type="button" class="chip-btn" data-val="__OTHER__">其他</button>
          </div>
          <input id="mk-transport-other" class="input hidden" style="margin-top:10px;" type="text" placeholder="請輸入其他交通工具" />
          <div id="err-mk-transport" class="field-error hidden"></div>
        </div>

        <div class="field">
          <label class="section-label" for="mk-companions">同行人員（選填，補出發不做同行代建）</label>
          <input id="mk-companions" class="input" type="text" placeholder="多位請以「、」分隔" />
        </div>

        <div class="field">
          <label class="section-label" for="mk-deputy">代理人（選填）</label>
          <select id="mk-deputy" class="select">
            <option value="">（不指定）</option>
            ${otherEmployees.map((e) => `<option value="${esc(e.name)}">${esc(e.name)}（${esc(e.title)}）</option>`).join('')}
          </select>
        </div>

        <div class="field">
          <label class="section-label" for="mk-reason">補打原因<span class="required-star">*</span></label>
          <input id="mk-reason" class="input" type="text" placeholder="例如：忘記打卡、訊號不佳" />
          <div id="err-mk-reason" class="field-error hidden"></div>
        </div>

        <button type="button" id="btn-mk-st-submit" class="btn btn-primary btn-block btn-lg">送出補打卡</button>
      `;

      const hasEndCb = document.getElementById('mk-has-end');
      const endGroup = document.getElementById('mk-end-group');
      hasEndCb.addEventListener('change', () => {
        endGroup.classList.toggle('hidden', !hasEndCb.checked);
      });

      const otherInput = document.getElementById('mk-transport-other');
      document.querySelectorAll('#mk-transport-chips .chip-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const val = btn.getAttribute('data-val');
          if (val === '__OTHER__') {
            otherOn = !otherOn;
            btn.classList.toggle('selected', otherOn);
            otherInput.classList.toggle('hidden', !otherOn);
          } else {
            if (selectedTransports.has(val)) {
              selectedTransports.delete(val);
              btn.classList.remove('selected');
            } else {
              selectedTransports.add(val);
              btn.classList.add('selected');
            }
          }
          clearFieldError('mk-transport');
        });
      });

      document.getElementById('btn-mk-st-submit').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        const sd = document.getElementById('mk-st-date').value;
        const st = document.getElementById('mk-st-time').value;
        const withEnd = hasEndCb.checked;
        const ed = document.getElementById('mk-en-date').value;
        const et = document.getElementById('mk-en-time').value;
        const location = document.getElementById('mk-location').value.trim();
        const purpose = document.getElementById('mk-purpose').value.trim();
        const companions = document.getElementById('mk-companions').value.trim();
        const deputy = document.getElementById('mk-deputy').value.trim();
        const reason = document.getElementById('mk-reason').value.trim();

        const tList = Array.from(selectedTransports);
        if (otherOn && otherInput.value.trim()) tList.push(otherInput.value.trim());
        const transport = tList.join('、');

        let valid = true;
        if (!sd || !st) { showFieldError('mk-st-time', '請填寫出發日期與時間'); valid = false; }
        else clearFieldError('mk-st-time');

        if (withEnd) {
          if (!ed || !et) { showFieldError('mk-en-time', '請填寫返回日期與時間'); valid = false; }
          else {
            const sDt = parseLocalDateTime(`${sd} ${st}`);
            const eDt = parseLocalDateTime(`${ed} ${et}`);
            if (sDt && eDt && eDt.getTime() < sDt.getTime()) {
              showFieldError('mk-en-time', '返回時間不可早於出發時間');
              valid = false;
            } else {
              clearFieldError('mk-en-time');
            }
          }
        } else {
          clearFieldError('mk-en-time');
        }

        if (!location) { showFieldError('mk-location', '請填寫地點／客戶'); valid = false; } else clearFieldError('mk-location');
        if (!purpose) { showFieldError('mk-purpose', '請填寫擬辦事項'); valid = false; } else clearFieldError('mk-purpose');
        if (!transport) { showFieldError('mk-transport', '請選擇交通工具'); valid = false; } else clearFieldError('mk-transport');
        if (!reason) { showFieldError('mk-reason', '請填寫補打原因'); valid = false; } else clearFieldError('mk-reason');
        if (!valid) return;

        btn.disabled = true;
        btn.textContent = '送出中…';
        try {
          await callGas('makeupTrip', {
            mode: 'start',
            startTime: `${sd} ${st}`,
            endTime: withEnd ? `${ed} ${et}` : '',
            location,
            purpose,
            transport,
            companions,
            deputy,
            reason,
          });
          showToast('補打卡送出成功！', 'success');
          await reloadBootstrap();
          navigateTo('checkin');
        } catch (err) {
          showToast(err.message, 'error');
          btn.disabled = false;
          btn.textContent = '送出補打卡';
        }
      });
    };

    $main().innerHTML = `
      <div class="card">
        <div class="page-title">
          <span>補打卡</span>
          <button type="button" id="btn-back-checkin" class="btn btn-ghost btn-sm">返回打卡頁</button>
        </div>
        <div class="month-tabs">
          <button type="button" class="month-tab makeup-mode-tab" data-mode="return">補返回</button>
          <button type="button" class="month-tab makeup-mode-tab" data-mode="start">補出發</button>
        </div>
        <div id="makeup-body"></div>
      </div>
    `;

    document.getElementById('btn-back-checkin').addEventListener('click', () => navigateTo('checkin'));
    document.querySelectorAll('.makeup-mode-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        mode = tab.getAttribute('data-mode');
        renderModeBody();
      });
    });
    renderModeBody();
  }

  // ==========================================================================
  // 頁面 6：本月草稿頁
  // ==========================================================================

  async function renderDraftPage() {
    const b = state.bootstrap;
    const targetMonth = state.draftMonth || b.defaultDraftMonth;
    $main().innerHTML = `<div class="loading-box"><div class="spinner"></div><p class="loading-text">正在讀取月報資料…</p></div>`;

    try {
      const data = await callGas('getMonthDraft', { yearMonth: targetMonth });
      state.draftData = data;
      drawDraftPage(data);
    } catch (err) {
      $main().innerHTML = `<div class="card"><div class="notice-box danger">${esc(err.message)}</div></div>`;
    }
  }

  function drawDraftPage(data) {
    const b = state.bootstrap;
    const prevM = b.defaultDraftMonth;
    const currM = b.currentMonth;
    const statusCls = data.status === '已確認' ? 'badge-confirmed'
      : (data.status === '逾期未確認' ? 'badge-overdue' : 'badge-draft');

    const tripsHtml = data.trips.length === 0
      ? '<div class="empty-state">這個月份目前沒有正常出差紀錄。</div>'
      : data.trips.map((t) => `
          <div class="trip-card">
            <div class="trip-card-head">
              <div class="trip-location">${esc(t.location)}</div>
              <button type="button" class="btn btn-ghost btn-sm btn-edit-trip" data-id="${esc(t.recordId)}" aria-label="修改">✏️ 修改</button>
            </div>
            <div class="trip-meta">🕒 ${esc(t.startTime)} ～ ${esc(t.endTime || '出差中（未返回）')}</div>
            <div class="trip-meta">📝 ${esc(t.purpose)}</div>
            <div class="trip-meta">🚗 ${esc(t.transport)}${t.companions ? `｜👥 ${esc(t.companions)}` : ''}${t.deputy ? `｜代：${esc(t.deputy)}` : ''}</div>
            <div class="trip-meta">
              天數：<strong>${t.days !== null ? `${t.days} 天` : '—'}</strong>
              ${t.hours !== null ? `｜時數：<strong>${t.hours} 小時</strong>` : ''}
            </div>
            ${t.makeupReason ? `<div class="trip-meta" style="color:var(--danger);">補登原因：${esc(t.makeupReason)}</div>` : ''}
            <div class="trip-tags">
              ${t.makeupType ? `<span class="badge badge-makeup">補登：${esc(t.makeupType)}</span>` : ''}
              ${t.createdBy && t.createdBy.startsWith('同行代建') ? `<span class="badge badge-companion">${esc(t.createdBy)}</span>` : ''}
            </div>
            <div class="trip-actions">
              <button type="button" class="btn btn-outline-danger btn-sm btn-void-trip" data-id="${esc(t.recordId)}" data-loc="${esc(t.location)}">作廢這筆</button>
            </div>
          </div>
        `).join('');

    $main().innerHTML = `
      <div class="month-tabs">
        <button type="button" class="month-tab ${data.yearMonth === prevM ? 'active' : ''}" data-sw-month="${esc(prevM)}">上個月（${esc(formatShortYm(prevM))}）</button>
        <button type="button" class="month-tab ${data.yearMonth === currM ? 'active' : ''}" data-sw-month="${esc(currM)}">本月（${esc(formatShortYm(currM))}）</button>
      </div>

      <div class="card">
        <div class="page-title">
          <span>${esc(data.monthInfo.title)}出差表</span>
          <span class="badge ${statusCls}">${esc(data.status)}</span>
        </div>

        <div class="summary-grid">
          <div class="summary-cell"><div class="summary-num">${data.summary.tripCount}</div><div class="summary-unit">趟數</div></div>
          <div class="summary-cell"><div class="summary-num">${data.summary.totalDays}</div><div class="summary-unit">天數合計</div></div>
          <div class="summary-cell"><div class="summary-num">${data.summary.totalHours}</div><div class="summary-unit">時數合計</div></div>
          <div class="summary-cell"><div class="summary-num ${data.summary.makeupCount > 0 ? 'warn' : ''}">${data.summary.makeupCount}</div><div class="summary-unit">補登筆數</div></div>
        </div>

        ${data.confirmedAt ? `<div class="notice-box" style="margin-top:0;">上次確認時間：${esc(data.confirmedAt)}</div>` : ''}
        ${data.hasIncompleteTrip ? `<div class="notice-box warn">尚有未打返回卡的紀錄，請先補打返回後再確認產生 PDF。</div>` : ''}
      </div>

      ${tripsHtml}

      ${data.trips.length > 0 ? `
        <div class="card">
          <button type="button" id="btn-confirm-month" class="btn btn-primary btn-block btn-lg" ${data.hasIncompleteTrip ? 'disabled' : ''}>
            ${data.status === '已確認' ? '📄 重新確認並覆蓋 PDF' : '✅ 確認並產生 PDF'}
          </button>
          <p style="font-size:14px;color:var(--text-muted);margin:10px 0 0;text-align:center;">
            請於 ${esc(data.monthInfo.nextMonthLabel)}/10 前確認。確認後還能修改，再確認一次會覆蓋舊的 PDF。
          </p>
        </div>
      ` : ''}
    `;

    // 切換上個月 / 本月
    document.querySelectorAll('[data-sw-month]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.draftMonth = btn.getAttribute('data-sw-month');
        renderDraftPage();
      });
    });

    // 編輯單筆
    document.querySelectorAll('.btn-edit-trip').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = btn.getAttribute('data-id');
        const trip = data.trips.find((x) => x.recordId === id);
        if (trip) {
          openEditTripModal(trip, async () => {
            await reloadBootstrap();
            renderDraftPage();
          });
        }
      });
    });

    // 作廢單筆
    document.querySelectorAll('.btn-void-trip').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        const loc = btn.getAttribute('data-loc');
        if (!confirm(`確定要作廢「${loc}」這筆出差紀錄嗎？（作廢後不列入月報）`)) return;
        try {
          const res = await callGas('voidTrip', { recordId: id });
          showToast(res.reportRevertedToDraft ? '已作廢紀錄，月報狀態已改回草稿' : '已作廢紀錄', 'success');
          await reloadBootstrap();
          renderDraftPage();
        } catch (err) {
          showToast(err.message, 'error');
        }
      });
    });

    // 確認並產生 PDF
    const confirmBtn = document.getElementById('btn-confirm-month');
    if (confirmBtn) {
      confirmBtn.addEventListener('click', async () => {
        if (!confirm(`確認 ${data.monthInfo.title} 出差表內容無誤，並產生 PDF 存檔嗎？`)) return;
        confirmBtn.disabled = true;
        confirmBtn.textContent = '正在產生 PDF（約 5～10 秒）…';
        try {
          const res = await callGas('confirmMonth', { yearMonth: data.yearMonth });
          showToast(`已確認並產生 ${res.fileName}`, 'success');
          renderDraftPage();
        } catch (err) {
          showToast(err.message, 'error');
          confirmBtn.disabled = false;
          confirmBtn.textContent = '✅ 確認並產生 PDF';
        }
      });
    }
  }

  // ==========================================================================
  // 共用彈窗：修改單筆出差紀錄（含時間）
  // ==========================================================================

  function openEditTripModal(trip, onSaved) {
    const [sDate, sTime] = splitDateTimeForInputs(trip.startTime);
    const [eDate, eTime] = splitDateTimeForInputs(trip.endTime);

    openModal(`
      <div class="modal-head">
        <h2 class="modal-title">修改出差紀錄</h2>
        <button type="button" class="modal-close" id="btn-edit-close">✕</button>
      </div>

      <div class="field">
        <span class="section-label">出發日期與時間<span class="required-star">*</span></span>
        <div class="datetime-grid">
          <input id="ed-st-date" class="input" type="date" value="${esc(sDate)}" />
          <input id="ed-st-time" class="input" type="time" value="${esc(sTime)}" />
        </div>
      </div>

      <div class="field">
        <span class="section-label">返回日期與時間（出差中可留空）</span>
        <div class="datetime-grid">
          <input id="ed-en-date" class="input" type="date" value="${esc(eDate)}" />
          <input id="ed-en-time" class="input" type="time" value="${esc(eTime)}" />
        </div>
        <div id="err-ed-time" class="field-error hidden"></div>
      </div>

      <div class="field">
        <label class="section-label" for="ed-location">地點／客戶<span class="required-star">*</span></label>
        <input id="ed-location" class="input" type="text" value="${esc(trip.location)}" />
      </div>

      <div class="field">
        <label class="section-label" for="ed-purpose">擬辦事項<span class="required-star">*</span></label>
        <textarea id="ed-purpose" class="textarea">${esc(trip.purpose)}</textarea>
      </div>

      <div class="field">
        <label class="section-label" for="ed-transport">交通工具<span class="required-star">*</span></label>
        <input id="ed-transport" class="input" type="text" value="${esc(trip.transport)}" placeholder="多項請以「、」連接" />
      </div>

      <div class="field">
        <label class="section-label" for="ed-companions">同行人員</label>
        <input id="ed-companions" class="input" type="text" value="${esc(trip.companions)}" />
      </div>

      <div class="field">
        <label class="section-label" for="ed-deputy">代理人</label>
        <input id="ed-deputy" class="input" type="text" value="${esc(trip.deputy)}" />
      </div>

      <div class="field">
        <label class="section-label" for="ed-reason">備註／補登原因</label>
        <input id="ed-reason" class="input" type="text" value="${esc(trip.makeupReason)}" placeholder="修改時間時建議填寫原因" />
      </div>

      <button type="button" id="btn-save-edit" class="btn btn-primary btn-block btn-lg">儲存修改</button>
    `);

    document.getElementById('btn-edit-close').addEventListener('click', closeModal);
    document.getElementById('btn-save-edit').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const sd = document.getElementById('ed-st-date').value;
      const st = document.getElementById('ed-st-time').value;
      const ed = document.getElementById('ed-en-date').value;
      const et = document.getElementById('ed-en-time').value;
      const location = document.getElementById('ed-location').value.trim();
      const purpose = document.getElementById('ed-purpose').value.trim();
      const transport = document.getElementById('ed-transport').value.trim();
      const companions = document.getElementById('ed-companions').value.trim();
      const deputy = document.getElementById('ed-deputy').value.trim();
      const makeupReason = document.getElementById('ed-reason').value.trim();

      if (!sd || !st) { showFieldError('ed-time', '出發時間不可空白'); return; }
      const startTime = `${sd} ${st}`;
      let endTime = '';
      if (ed || et) {
        if (!ed || !et) { showFieldError('ed-time', '返回日期與時間需同時填寫'); return; }
        endTime = `${ed} ${et}`;
        const sDt = parseLocalDateTime(startTime);
        const eDt = parseLocalDateTime(endTime);
        if (sDt && eDt && eDt.getTime() < sDt.getTime()) {
          showFieldError('ed-time', '返回時間不可早於出發時間');
          return;
        }
      }
      clearFieldError('ed-time');

      btn.disabled = true;
      btn.textContent = '儲存中…';
      try {
        const res = await callGas('editTrip', {
          recordId: trip.recordId,
          startTime,
          endTime,
          location,
          purpose,
          transport,
          companions,
          deputy,
          makeupReason,
        });
        closeModal();
        showToast(res.reportRevertedToDraft ? '已儲存修改，月報狀態已改回草稿' : '已儲存修改', 'success');
        if (onSaved) onSaved();
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false;
        btn.textContent = '儲存修改';
      }
    });
  }

  // ==========================================================================
  // 頁面 7：我的紀錄頁（含 PDF 預覽與下載，免 Google 帳號）
  // ==========================================================================

  async function renderRecordsPage() {
    $main().innerHTML = `<div class="loading-box"><div class="spinner"></div><p class="loading-text">正在讀取歷史紀錄…</p></div>`;
    try {
      const data = await callGas('getMyRecords', { year: state.recordsYear || undefined });
      state.recordsData = data;
      state.recordsYear = data.selectedYear;
      drawRecordsPage(data);
    } catch (err) {
      $main().innerHTML = `<div class="card"><div class="notice-box danger">${esc(err.message)}</div></div>`;
    }
  }

  function drawRecordsPage(data) {
    const monthsHtml = data.months.length === 0
      ? '<div class="empty-state">這個年度尚無出差紀錄。</div>'
      : data.months.map((m) => {
          const statusCls = m.status === '已確認' ? 'badge-confirmed'
            : (m.status === '逾期未確認' ? 'badge-overdue' : 'badge-draft');
          return `
            <div class="record-month-card">
              <div class="record-month-info" data-open-month="${esc(m.yearMonth)}">
                <div class="record-month-title">
                  <span>${esc(m.title)}</span>
                  <span class="badge ${statusCls}">${esc(m.status)}</span>
                </div>
                <div class="record-month-sub">
                  出差 ${m.tripCount} 趟・共 ${m.totalDays} 天${m.totalHours ? `・${m.totalHours} 小時` : ''}（點此看明細）
                </div>
              </div>
              <div>
                ${m.hasPdf
                  ? `<button type="button" class="btn btn-primary btn-sm btn-pdf-dl" data-ym="${esc(m.yearMonth)}">下載 PDF</button>`
                  : `<button type="button" class="btn btn-outline btn-sm btn-go-confirm" data-ym="${esc(m.yearMonth)}">去確認</button>`
                }
              </div>
            </div>
          `;
        }).join('');

    $main().innerHTML = `
      <div class="card">
        <div class="page-title">
          <span>我的出差紀錄</span>
          <select id="rec-year-select" class="select" style="width:auto;min-height:44px;padding:6px 12px;">
            ${data.availableYears.map((y) => `
              <option value="${y.year}" ${y.year === data.selectedYear ? 'selected' : ''}>民國 ${y.rocYear} 年（${y.year}）</option>
            `).join('')}
          </select>
        </div>
        <p style="font-size:14px;color:var(--text-muted);margin:0;">點選任一月份可查看或修改明細；已確認月份可直接預覽與下載 PDF。</p>
      </div>
      ${monthsHtml}
    `;

    document.getElementById('rec-year-select').addEventListener('change', (e) => {
      state.recordsYear = Number(e.target.value);
      renderRecordsPage();
    });

    document.querySelectorAll('[data-open-month]').forEach((el) => {
      el.addEventListener('click', () => {
        navigateTo('draft', { month: el.getAttribute('data-open-month') });
      });
    });

    document.querySelectorAll('.btn-go-confirm').forEach((btn) => {
      btn.addEventListener('click', () => {
        navigateTo('draft', { month: btn.getAttribute('data-ym') });
      });
    });

    document.querySelectorAll('.btn-pdf-dl').forEach((btn) => {
      btn.addEventListener('click', () => {
        openPdfPreviewModal(btn.getAttribute('data-ym'));
      });
    });
  }

  /**
   * PDF 下載與內建預覽（相容 iOS / Android LINE 內建瀏覽器，不需 Google 帳號）
   */
  async function openPdfPreviewModal(yearMonth) {
    openModal(`
      <div class="modal-head">
        <h2 class="modal-title">月出差表 PDF</h2>
        <button type="button" class="modal-close" id="btn-pdf-close">✕</button>
      </div>
      <div class="loading-box" style="padding:36px 12px;">
        <div class="spinner"></div>
        <p class="loading-text">正在安全下載 PDF…</p>
      </div>
    `);
    document.getElementById('btn-pdf-close').addEventListener('click', closeModal);

    try {
      const res = await callGas('downloadMonthPdf', { yearMonth });
      const bytes = base64ToUint8Array(res.base64);
      const blob = new Blob([bytes], { type: 'application/pdf' });
      const blobUrl = URL.createObjectURL(blob);

      $modalSheet().innerHTML = `
        <div class="modal-head">
          <h2 class="modal-title">${esc(res.fileName)}</h2>
          <button type="button" class="modal-close" id="btn-pdf-close">✕</button>
        </div>

        <div class="btn-row" style="margin-bottom:10px;">
          <a id="btn-pdf-save" class="btn btn-primary" href="${blobUrl}" download="${esc(res.fileName)}" style="text-decoration:none;">⬇️ 下載 PDF</a>
        </div>

        <div class="notice-box" style="margin-top:0;">
          <strong>手機儲存提示：</strong>若 LINE 內建瀏覽器無法直接下載 PDF，下方已為您展開報表圖片，請<strong>長按下方報表圖片即可儲存到相簿</strong>，或點選「下載 PDF」。
        </div>

        <div id="pdf-pages" class="pdf-pages">
          <div class="loading-box" style="padding:24px;"><div class="spinner"></div><p class="loading-text">正在渲染預覽頁面…</p></div>
        </div>
      `;

      document.getElementById('btn-pdf-close').addEventListener('click', () => {
        URL.revokeObjectURL(blobUrl);
        closeModal();
      });

      // 使用 PDF.js 將 PDF 每頁渲染為高解析度圖片（iOS/Android LINE WebView 皆可檢視與長按儲存）
      if (window.pdfjsLib) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc =
          'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        const pdfDoc = await window.pdfjsLib.getDocument({ data: bytes }).promise;
        const container = document.getElementById('pdf-pages');
        container.innerHTML = '';

        for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
          const page = await pdfDoc.getPage(pageNum);
          const viewport = page.getViewport({ scale: 2.0 });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;

          const img = document.createElement('img');
          img.src = canvas.toDataURL('image/png');
          img.alt = `${res.fileName} 第 ${pageNum} 頁`;
          img.className = 'pdf-page-img';
          container.appendChild(img);
        }
      }
    } catch (err) {
      $modalSheet().innerHTML = `
        <div class="modal-head">
          <h2 class="modal-title">無法載入 PDF</h2>
          <button type="button" class="modal-close" id="btn-pdf-close">✕</button>
        </div>
        <div class="notice-box danger">${esc(err.message)}</div>
      `;
      document.getElementById('btn-pdf-close').addEventListener('click', closeModal);
    }
  }

  // ==========================================================================
  // 工具函式
  // ==========================================================================

  function openModal(html) {
    $modalSheet().innerHTML = html;
    $modalBackdrop().classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeModal() {
    $modalBackdrop().classList.add('hidden');
    $modalSheet().innerHTML = '';
    document.body.style.overflow = '';
  }

  function renderFatalError(title, desc) {
    $main().innerHTML = `
      <div class="card" style="text-align:center;padding:36px 20px;">
        <div style="font-size:42px;margin-bottom:10px;">⚠️</div>
        <h1 class="page-title" style="justify-content:center;">${esc(title)}</h1>
        <p style="color:var(--text-muted);">${esc(desc)}</p>
      </div>
    `;
  }

  let toastTimer = null;
  function showToast(msg, type) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `toast ${type || ''}`;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  function showFieldError(id, msg) {
    const el = document.getElementById(`err-${id}`);
    if (el) {
      el.textContent = msg;
      el.classList.remove('hidden');
    }
    const input = document.getElementById(id);
    if (input) input.classList.add('has-error');
  }

  function clearFieldError(id) {
    const el = document.getElementById(`err-${id}`);
    if (el) el.classList.add('hidden');
    const input = document.getElementById(id);
    if (input) input.classList.remove('has-error');
  }

  function esc(str) {
    return String(str === null || str === undefined ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function parseLocalDateTime(str) {
    if (!str) return null;
    const m = String(str).trim().match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})[ T](\d{1,2}):(\d{2})/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  }

  function splitDateTimeForInputs(str) {
    if (!str) return ['', ''];
    const m = String(str).trim().match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})[ T](\d{1,2}):(\d{2})/);
    if (!m) return ['', ''];
    const pad = (n) => String(n).padStart(2, '0');
    return [`${m[1]}-${pad(m[2])}-${pad(m[3])}`, `${pad(m[4])}:${m[5]}`];
  }

  function getTodayDateInput() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  function formatShortYm(ym) {
    const m = String(ym || '').match(/^(\d{4})-(\d{2})$/);
    if (!m) return ym;
    return `${Number(m[1]) - 1911}/${Number(m[2])}月`;
  }

  function base64ToUint8Array(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  document.addEventListener('DOMContentLoaded', init);
})();
