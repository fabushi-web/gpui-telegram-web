/* Fabushi Web v1.6.11 — Official Telegram WebApp SDK v8.0 + WebMCP (navigator.modelContext) Bridge
 * Zero fake identity/initData, honest server-backed CloudStorage, origin-checked postMessage. */
(function () {
  var hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
  var searchParams = new URLSearchParams(window.location.search || '');

  var initData = '';
  if (typeof window.__TG_INIT_DATA__ === 'string' && window.__TG_INIT_DATA__.trim()) {
    initData = window.__TG_INIT_DATA__.trim();
  } else if (hashParams.get('tgWebAppData')) {
    initData = hashParams.get('tgWebAppData') || '';
  } else if (searchParams.get('tgWebAppData')) {
    initData = searchParams.get('tgWebAppData') || '';
  } else if (hashParams.get('init_data')) {
    initData = hashParams.get('init_data') || '';
  } else if (searchParams.get('init_data')) {
    initData = searchParams.get('init_data') || '';
  }

  var authToken = '';
  if (typeof window.__TG_AUTH_TOKEN__ === 'string' && window.__TG_AUTH_TOKEN__.trim()) {
    authToken = window.__TG_AUTH_TOKEN__.trim();
  } else if (hashParams.get('auth_token')) {
    authToken = (hashParams.get('auth_token') || '').trim();
  } else if (searchParams.get('auth_token')) {
    authToken = (searchParams.get('auth_token') || '').trim();
  }

  var initDataUnsafe = {};
  if (initData) {
    var parsedInit = new URLSearchParams(initData);
    var parsedUser = undefined;
    try {
      var rawUser = parsedInit.get('user');
      if (rawUser) parsedUser = JSON.parse(rawUser);
    } catch (_) {}
    if (parsedInit.get('query_id')) initDataUnsafe.query_id = parsedInit.get('query_id');
    if (parsedUser !== undefined) initDataUnsafe.user = parsedUser;
    if (parsedInit.get('auth_date')) initDataUnsafe.auth_date = Number(parsedInit.get('auth_date'));
    if (parsedInit.get('hash')) initDataUnsafe.hash = parsedInit.get('hash');
    if (parsedInit.get('start_param')) initDataUnsafe.start_param = parsedInit.get('start_param');
  }

  var defaultThemeParams = {
    bg_color: '#1C1C1E',
    text_color: '#F5F5F5',
    hint_color: '#8E8E93',
    link_color: '#0A84FF',
    button_color: '#0A84FF',
    button_text_color: '#FFFFFF',
    secondary_bg_color: '#0E0E0E',
    header_bg_color: '#1C1C1E'
  };
  var rawTheme = hashParams.get('tgWebAppThemeParams') || searchParams.get('tgWebAppThemeParams');
  if (rawTheme) {
    try {
      var parsedTheme = JSON.parse(rawTheme);
      if (parsedTheme && typeof parsedTheme === 'object') {
        Object.assign(defaultThemeParams, parsedTheme);
      }
    } catch (_) {}
  }

  var listeners = {};
  function emit(eventType, payload) {
    var list = listeners[eventType] || [];
    for (var i = 0; i < list.length; i++) {
      try { list[i](payload); } catch (_) {}
    }
  }

  function parseAllowedOrigin(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
      var parsed = new URL(rawUrl);
      var host = (parsed.hostname || '').toLowerCase();
      var isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
      if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopback)) {
        return parsed.origin;
      }
    } catch (_) {}
    return '';
  }

  function resolveParentHostOrigin() {
    if (window.parent && window.parent !== window) {
      var fromReferrer = parseAllowedOrigin(document.referrer);
      if (fromReferrer) return fromReferrer;
      var fromHash = parseAllowedOrigin(hashParams.get('tgWebAppHostOrigin') || searchParams.get('tgWebAppHostOrigin'));
      if (fromHash) return fromHash;
    }
    if (window.location && window.location.origin && window.location.origin !== 'null') {
      return window.location.origin;
    }
    return '';
  }

  var trustedHostOrigin = resolveParentHostOrigin();

  function resolveTargetOrigin() {
    if (trustedHostOrigin) {
      return trustedHostOrigin;
    }
    if (window.location && window.location.origin && window.location.origin !== 'null') {
      return window.location.origin;
    }
    return '*';
  }

  function postToHost(eventType, eventData) {
    var payload = { type: 'telegram_web_app_event', eventType: eventType, eventData: eventData || {} };
    var targetOrigin = resolveTargetOrigin();
    try {
      if (window.TelegramWebviewProxy && typeof window.TelegramWebviewProxy.postEvent === 'function') {
        window.TelegramWebviewProxy.postEvent(eventType, JSON.stringify(eventData || {}));
      } else if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.telegramWebApp) {
        window.webkit.messageHandlers.telegramWebApp.postMessage(payload);
      } else if (window.parent && window.parent !== window) {
        window.parent.postMessage(payload, targetOrigin);
      } else if (eventType === 'webmcp_response' || eventType === 'webmcp_state_update') {
        window.postMessage(payload, targetOrigin);
      }
    } catch (_) {}
  }

  function resolveMiniAppPathSuffix() {
    var parts = (window.location.pathname || '').split('/').filter(Boolean);
    var miniIdx = parts.indexOf('miniapps');
    if (miniIdx >= 0) {
      var seg1 = parts[miniIdx + 1];
      var seg2 = parts[miniIdx + 2];
      if (seg1 === 'fabushi-globe') {
        return '/api/v1/miniapps/FabushiBot/fabushi-globe';
      }
      if (seg1 && seg2 && !seg2.endsWith('.html')) {
        return '/api/v1/miniapps/' + encodeURIComponent(seg1) + '/' + encodeURIComponent(seg2);
      }
    }
    return '/api/v1/miniapps/FabushiBot/fabushi-globe';
  }

  function resolveMiniAppApiBase() {
    var suffix = resolveMiniAppPathSuffix();
    var rawBase = '';
    if (typeof window.__TG_API_BASE__ === 'string' && window.__TG_API_BASE__.trim()) {
      rawBase = window.__TG_API_BASE__.trim().replace(/\/+$/, '');
    } else if (hashParams.get('api_base') && hashParams.get('api_base').trim()) {
      rawBase = hashParams.get('api_base').trim().replace(/\/+$/, '');
    } else if (searchParams.get('api_base') && searchParams.get('api_base').trim()) {
      rawBase = searchParams.get('api_base').trim().replace(/\/+$/, '');
    }
    if (rawBase) {
      if (rawBase.indexOf('/api/v1/miniapps/') !== -1) {
        return rawBase;
      }
      return rawBase + suffix;
    }
    return suffix;
  }

  var apiBase = resolveMiniAppApiBase();
  var storageUrl = apiBase + '/storage';
  var sendDataUrl = apiBase + '/send-data';

  function buildAuthHeaders(extra) {
    var headers = Object.assign({}, extra || {});
    if (initData) headers['X-Telegram-Init-Data'] = initData;
    var activeToken = (typeof window.__TG_AUTH_TOKEN__ === 'string' && window.__TG_AUTH_TOKEN__.trim())
      ? window.__TG_AUTH_TOKEN__.trim()
      : authToken;
    if (activeToken) {
      headers['Authorization'] = 'Bearer ' + activeToken;
    }
    return headers;
  }

  var MainButton = {
    text: 'CONTINUE',
    color: '#0A84FF',
    textColor: '#FFFFFF',
    isVisible: false,
    isActive: true,
    isProgressVisible: false,
    setText: function (t) { this.text = String(t); postToHost('web_app_setup_main_button', { text: this.text, is_visible: this.isVisible, is_active: this.isActive, color: this.color, text_color: this.textColor }); return this; },
    show: function () { this.isVisible = true; postToHost('web_app_setup_main_button', { text: this.text, is_visible: true, is_active: this.isActive, color: this.color, text_color: this.textColor }); return this; },
    hide: function () { this.isVisible = false; postToHost('web_app_setup_main_button', { text: this.text, is_visible: false, is_active: this.isActive }); return this; },
    enable: function () { this.isActive = true; return this; },
    disable: function () { this.isActive = false; return this; },
    showProgress: function () { this.isProgressVisible = true; return this; },
    hideProgress: function () { this.isProgressVisible = false; return this; },
    setParams: function (p) { if (!p) return this; if (p.text) this.text = String(p.text); if (p.color) this.color = String(p.color); if (p.text_color) this.textColor = String(p.text_color); if (p.is_visible !== undefined) this.isVisible = Boolean(p.is_visible); if (p.is_active !== undefined) this.isActive = Boolean(p.is_active); postToHost('web_app_setup_main_button', { text: this.text, is_visible: this.isVisible, is_active: this.isActive, color: this.color, text_color: this.textColor }); return this; },
    onClick: function (cb) { WebApp.onEvent('mainButtonClicked', cb); return this; },
    offClick: function (cb) { WebApp.offEvent('mainButtonClicked', cb); return this; }
  };

  var SecondaryButton = {
    text: '',
    color: '#2C2C2E',
    textColor: '#FFFFFF',
    isVisible: false,
    isActive: true,
    position: 'left',
    setText: function (t) { this.text = String(t); postToHost('web_app_setup_secondary_button', { text: this.text, is_visible: this.isVisible, is_active: this.isActive, color: this.color, text_color: this.textColor, position: this.position }); return this; },
    show: function () { this.isVisible = true; postToHost('web_app_setup_secondary_button', { text: this.text, is_visible: true, is_active: this.isActive, position: this.position }); return this; },
    hide: function () { this.isVisible = false; postToHost('web_app_setup_secondary_button', { text: this.text, is_visible: false, is_active: this.isActive }); return this; },
    setParams: function (p) { if (!p) return this; if (p.text) this.text = String(p.text); if (p.is_visible !== undefined) this.isVisible = Boolean(p.is_visible); postToHost('web_app_setup_secondary_button', { text: this.text, is_visible: this.isVisible, is_active: this.isActive }); return this; },
    onClick: function (cb) { WebApp.onEvent('secondaryButtonClicked', cb); return this; },
    offClick: function (cb) { WebApp.offEvent('secondaryButtonClicked', cb); return this; }
  };

  var BackButton = {
    isVisible: false,
    show: function () { this.isVisible = true; postToHost('web_app_setup_back_button', { is_visible: true }); return this; },
    hide: function () { this.isVisible = false; postToHost('web_app_setup_back_button', { is_visible: false }); return this; },
    onClick: function (cb) { WebApp.onEvent('backButtonClicked', cb); return this; },
    offClick: function (cb) { WebApp.offEvent('backButtonClicked', cb); return this; }
  };

  var SettingsButton = {
    isVisible: false,
    show: function () { this.isVisible = true; postToHost('web_app_setup_settings_button', { is_visible: true }); return this; },
    hide: function () { this.isVisible = false; postToHost('web_app_setup_settings_button', { is_visible: false }); return this; },
    onClick: function (cb) { WebApp.onEvent('settingsButtonClicked', cb); return this; },
    offClick: function (cb) { WebApp.offEvent('settingsButtonClicked', cb); return this; }
  };

  var CloudStorage = {
    setItem: function (key, value, cb) {
      return fetch(storageUrl, {
        method: 'PUT',
        headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ key: key, value: String(value) })
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        if (cb) cb(null, true);
        return true;
      }).catch(function (e) {
        if (cb) cb(String(e && e.message ? e.message : e), false);
        return false;
      });
    },
    getItem: function (key, cb) {
      return fetch(storageUrl + '?keys=' + encodeURIComponent(key), {
        headers: buildAuthHeaders()
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (d) {
        var map = (d && (d.entries || d.items)) || {};
        var val = map[key] !== undefined ? map[key] : '';
        if (cb) cb(null, val);
        return val;
      }).catch(function (e) {
        if (cb) cb(String(e && e.message ? e.message : e), '');
        return '';
      });
    },
    getItems: function (keys, cb) {
      return fetch(storageUrl + '?keys=' + encodeURIComponent((keys || []).join(',')), {
        headers: buildAuthHeaders()
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function (d) {
        var map = (d && (d.entries || d.items)) || {};
        if (cb) cb(null, map);
        return map;
      }).catch(function (e) {
        if (cb) cb(String(e && e.message ? e.message : e), {});
        return {};
      });
    },
    removeItem: function (key, cb) {
      return fetch(storageUrl + '/' + encodeURIComponent(key), {
        method: 'DELETE',
        headers: buildAuthHeaders()
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        if (cb) cb(null, true);
        return true;
      }).catch(function (e) {
        if (cb) cb(String(e && e.message ? e.message : e), false);
        return false;
      });
    },
    removeItems: function (keys, cb) {
      return fetch(storageUrl, {
        method: 'DELETE',
        headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ keys: keys })
      }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        if (cb) cb(null, true);
        return true;
      }).catch(function (e) {
        if (cb) cb(String(e && e.message ? e.message : e), false);
        return false;
      });
    },
    getKeys: function (cb) {
      return fetch(storageUrl, { headers: buildAuthHeaders() })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (d) {
          var keys = (d && d.keys) || [];
          if (cb) cb(null, keys);
          return keys;
        })
        .catch(function (e) {
          if (cb) cb(String(e && e.message ? e.message : e), []);
          return [];
        });
    }
  };

  var WebApp = {
    initData: initData,
    initDataUnsafe: initDataUnsafe,
    version: '8.0',
    platform: 'weba',
    colorScheme: 'dark',
    themeParams: defaultThemeParams,
    isExpanded: true,
    viewportHeight: window.innerHeight || 640,
    viewportStableHeight: window.innerHeight || 640,
    MainButton: MainButton,
    BottomButton: MainButton,
    SecondaryButton: SecondaryButton,
    BackButton: BackButton,
    SettingsButton: SettingsButton,
    HapticFeedback: {
      impactOccurred: function (style) { postToHost('web_app_trigger_haptic_feedback', { type: 'impact', impact_style: style }); },
      notificationOccurred: function (type) { postToHost('web_app_trigger_haptic_feedback', { type: 'notification', notification_type: type }); },
      selectionChanged: function () { postToHost('web_app_trigger_haptic_feedback', { type: 'selection_change' }); }
    },
    CloudStorage: CloudStorage,
    ready: function () { postToHost('web_app_ready', {}); },
    expand: function () { this.isExpanded = true; postToHost('web_app_expand', {}); },
    requestFullscreen: function () { postToHost('web_app_request_fullscreen', {}); },
    exitFullscreen: function () { postToHost('web_app_exit_fullscreen', {}); },
    close: function () { postToHost('web_app_close', {}); },
    setHeaderColor: function (c) { postToHost('web_app_set_header_color', { color: c }); },
    setBackgroundColor: function (c) { postToHost('web_app_set_background_color', { color: c }); },
    sendData: function (dataStr) {
      var str = typeof dataStr === 'string' ? dataStr : JSON.stringify(dataStr);
      postToHost('web_app_data_send', { data: str });
      return fetch(sendDataUrl, {
        method: 'POST',
        headers: buildAuthHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ data: str })
      });
    },
    requestWriteAccess: function (cb) { postToHost('web_app_request_write_access', {}); if (cb) cb(true); },
    openLink: function (url) { postToHost('web_app_open_link', { url: String(url) }); },
    openTelegramLink: function (url) { postToHost('web_app_open_tg_link', { url: String(url) }); },
    showPopup: function (params, cb) { postToHost('web_app_open_popup', params || {}); if (cb) cb('ok'); },
    showAlert: function (msg, cb) { postToHost('web_app_open_popup', { message: String(msg) }); if (cb) cb(); },
    showConfirm: function (msg, cb) { postToHost('web_app_open_popup', { message: String(msg) }); if (cb) cb(true); },
    onEvent: function (eventType, cb) {
      listeners[eventType] = listeners[eventType] || [];
      listeners[eventType].push(cb);
    },
    offEvent: function (eventType, cb) {
      listeners[eventType] = (listeners[eventType] || []).filter(function (fn) { return fn !== cb; });
    }
  };

  window.Telegram = window.Telegram || {};
  window.Telegram.WebApp = WebApp;

  // ========================================================================
  // WebMCP (navigator.modelContext + window.__GPUI_WEBMCP__)
  // ========================================================================
  var pageErrors = [];
  function pushPageError(msg) {
    if (!msg) return;
    pageErrors.push(String(msg).slice(0, 400));
    if (pageErrors.length > 5) pageErrors.shift();
  }
  window.addEventListener('error', function (ev) {
    pushPageError((ev && ev.message) || 'Runtime error');
  });
  window.addEventListener('unhandledrejection', function (ev) {
    var r = ev && ev.reason;
    pushPageError(r && r.message ? r.message : String(r || 'Unhandled rejection'));
  });

  function scrapeVisibleToast() {
    try {
      var sels = ['#toast', '[role="alert"]', '.toast', '.error-banner'];
      for (var i = 0; i < sels.length; i++) {
        var el = document.querySelector(sels[i]);
        if (el && el.offsetParent !== null) {
          var txt = (el.textContent || '').trim();
          if (txt) return txt.slice(0, 300);
        }
      }
    } catch (_) {}
    return undefined;
  }

  var registeredTools = new Map();
  var stateProviderFn = null;

  var builtinTools = [
    { name: 'get_state', description: 'Read current Mini App state summary', input_schema: { type: 'object', properties: {} }, read_only: true },
    { name: 'page_inspect', description: 'Inspect visible interactive elements on page', input_schema: { type: 'object', properties: {} }, read_only: true },
    { name: 'page_click', description: 'Click an element by CSS selector or text', input_schema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' } } }, read_only: false },
    { name: 'page_fill', description: 'Fill an input element by CSS selector', input_schema: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' } }, required: ['selector', 'value'] }, read_only: false },
    { name: 'page_press_main_button', description: 'Trigger Telegram WebApp MainButton click', input_schema: { type: 'object', properties: {} }, read_only: false },
    { name: 'page_press_secondary_button', description: 'Trigger Telegram WebApp SecondaryButton click', input_schema: { type: 'object', properties: {} }, read_only: false }
  ];

  function readStateSummary() {
    var customState = {};
    if (typeof stateProviderFn === 'function') {
      try { customState = stateProviderFn() || {}; } catch (e) { pushPageError(String(e)); }
    }
    var summary = {
      ok: pageErrors.length === 0,
      title: document.title || '',
      url: window.location.href || '',
      state: customState,
      main_button: { is_visible: MainButton.isVisible, text: MainButton.text },
      secondary_button: { is_visible: SecondaryButton.isVisible, text: SecondaryButton.text }
    };
    if (pageErrors.length > 0) summary.page_errors = pageErrors.slice();
    var toast = scrapeVisibleToast();
    if (toast) summary.visible_toast = toast;
    if (customState && typeof customState.boot_error === 'string' && customState.boot_error) {
      summary.boot_error = customState.boot_error;
      summary.ok = false;
    }
    if (customState && typeof customState.status_text === 'string' && customState.status_text) {
      summary.status_text = customState.status_text;
    }
    return summary;
  }

  function discoverTools() {
    var list = builtinTools.slice();
    registeredTools.forEach(function (spec) {
      list.push({
        name: spec.name,
        description: spec.description || '',
        input_schema: spec.inputSchema || spec.input_schema || { type: 'object', properties: {} },
        read_only: Boolean(spec.readOnly || spec.read_only || (spec.annotations && spec.annotations.readOnlyHint))
      });
    });
    return list;
  }

  function executeBuiltinTool(toolName, args) {
    args = args || {};
    if (toolName === 'get_state') return readStateSummary();
    if (toolName === 'page_inspect') {
      var nodes = Array.prototype.slice.call(document.querySelectorAll('button,a,input,select,textarea,[role="button"]')).slice(0, 40);
      return {
        title: document.title || '',
        elements: nodes.map(function (el) {
          return {
            tag: el.tagName.toLowerCase(),
            id: el.id || undefined,
            text: (el.textContent || '').trim().slice(0, 80),
            aria_label: el.getAttribute('aria-label') || undefined
          };
        })
      };
    }
    if (toolName === 'page_click') {
      var target = args.selector ? document.querySelector(args.selector) : null;
      if (!target && args.text) {
        var all = document.querySelectorAll('button,a,[role="button"]');
        for (var i = 0; i < all.length; i++) {
          if ((all[i].textContent || '').trim().indexOf(args.text) !== -1) { target = all[i]; break; }
        }
      }
      if (!target) throw new Error('Element not found');
      target.click();
      return { clicked: true };
    }
    if (toolName === 'page_fill') {
      var inp = args.selector ? document.querySelector(args.selector) : null;
      if (!inp) throw new Error('Input not found');
      inp.value = String(args.value || '');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return { filled: true };
    }
    if (toolName === 'page_press_main_button') {
      emit('mainButtonClicked');
      return { pressed: 'main_button' };
    }
    if (toolName === 'page_press_secondary_button') {
      emit('secondaryButtonClicked');
      return { pressed: 'secondary_button' };
    }
    throw new Error('Unknown tool: ' + toolName);
  }

  var gpuiWebMcp = {
    _tools: registeredTools,
    _stateProvider: function () { return stateProviderFn; },
    _pageErrors: pageErrors,
    discover: discoverTools,
    readState: readStateSummary,
    invoke: function (requestId, operation, toolName, args) {
      var finish = function (ok, result, errMsg) {
        var resp = {
          request_id: requestId,
          ok: ok,
          result: result !== undefined ? result : null,
          error: errMsg || null,
          tools: discoverTools(),
          state_summary: readStateSummary(),
          control_mode: 'ai_controlling'
        };
        postToHost('webmcp_response', resp);
        return resp;
      };
      try {
        if (operation === 'discover') return Promise.resolve(finish(true, { tools: discoverTools() }, null));
        if (operation === 'get_state') return Promise.resolve(finish(true, readStateSummary(), null));
        if (operation === 'call_tool') {
          var custom = registeredTools.get(toolName);
          if (custom && typeof custom.execute === 'function') {
            return Promise.resolve(custom.execute(args || {})).then(
              function (r) { return finish(true, r, null); },
              function (e) { return finish(false, null, String(e && e.message ? e.message : e)); }
            );
          }
          return Promise.resolve(finish(true, executeBuiltinTool(toolName, args), null));
        }
        return Promise.resolve(finish(false, null, 'Unsupported operation: ' + operation));
      } catch (e) {
        return Promise.resolve(finish(false, null, String(e && e.message ? e.message : e)));
      }
    }
  };
  window.__GPUI_WEBMCP__ = gpuiWebMcp;

  var modelContext = {
    registerTool: function (spec) {
      if (!spec || typeof spec.name !== 'string' || !spec.name.trim()) return;
      registeredTools.set(spec.name.trim(), spec);
    },
    unregisterTool: function (name) { registeredTools.delete(String(name)); },
    provideContext: function (ctxObj) {
      registeredTools.clear();
      if (ctxObj && Array.isArray(ctxObj.tools)) {
        ctxObj.tools.forEach(function (t) { modelContext.registerTool(t); });
      }
    },
    clearContext: function () { registeredTools.clear(); },
    setStateProvider: function (fn) { stateProviderFn = typeof fn === 'function' ? fn : null; },
    reportStatus: function (statusOrObj) {
      var summary = readStateSummary();
      var payload;
      if (statusOrObj && typeof statusOrObj === 'object') {
        var merged = Object.assign({}, summary, statusOrObj);
        if (typeof statusOrObj.boot_error === 'string' && statusOrObj.boot_error) {
          merged.ok = false;
        }
        payload = Object.assign({}, statusOrObj, {
          status_text: typeof statusOrObj.status_text === 'string'
            ? statusOrObj.status_text
            : typeof statusOrObj.message === 'string'
              ? statusOrObj.message
              : typeof statusOrObj.boot_error === 'string'
                ? statusOrObj.boot_error
                : '',
          state_summary: merged
        });
      } else {
        payload = {
          status_text: typeof statusOrObj === 'string' ? statusOrObj : String(statusOrObj || ''),
          state_summary: summary
        };
      }
      postToHost('webmcp_state_update', payload);
    }
  };

  try {
    Object.defineProperty(navigator, 'modelContext', {
      value: modelContext,
      configurable: true,
      writable: true
    });
  } catch (_) {
    try { navigator.modelContext = modelContext; } catch (__) {}
  }

  window.addEventListener('message', function (ev) {
    if (window.parent && window.parent !== window && ev.source !== window.parent) {
      return;
    }
    var allowedOrigin = trustedHostOrigin || (window.location.origin !== 'null' ? window.location.origin : '');
    if (allowedOrigin && ev.origin && ev.origin !== allowedOrigin && ev.origin !== window.location.origin) {
      return;
    }
    try {
      var msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
      if (!msg || !msg.eventType) return;
      if (msg.eventType === 'main_button_pressed') {
        emit('mainButtonClicked');
      } else if (msg.eventType === 'secondary_button_pressed') {
        emit('secondaryButtonClicked');
      } else if (msg.eventType === 'back_button_pressed') {
        emit('backButtonClicked');
      } else if (msg.eventType === 'settings_button_pressed') {
        emit('settingsButtonClicked');
      } else if (msg.eventType === 'theme_changed' && msg.eventData) {
        Object.assign(WebApp.themeParams, msg.eventData.theme_params || {});
        emit('themeChanged', msg.eventData);
      } else if (msg.eventType === 'webmcp_command' && msg.eventData) {
        var cmd = msg.eventData;
        gpuiWebMcp.invoke(cmd.request_id, cmd.operation, cmd.tool_name, cmd.arguments || {});
      } else {
        emit(msg.eventType, msg.eventData);
      }
    } catch (_) {}
  });
})();
