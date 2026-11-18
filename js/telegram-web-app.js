(function () {
  if (window.Telegram && window.Telegram.WebApp) {
    return;
  }

  var NIGHT_THEME_PARAMS = {
    bg_color: '#0E1621',
    secondary_bg_color: '#17212B',
    header_bg_color: '#17212B',
    section_bg_color: '#182533',
    text_color: '#F5F5F5',
    hint_color: '#7F91A4',
    link_color: '#64B5F6',
    button_color: '#3390EC',
    button_text_color: '#FFFFFF',
    destructive_text_color: '#E53935'
  };

  var hashParams = new URLSearchParams((window.location.hash || '').replace(/^#/, ''));
  var searchParams = new URLSearchParams(window.location.search || '');
  var rawInitData =
    hashParams.get('tgWebAppData') ||
    searchParams.get('tgWebAppData') ||
    '';

  if (!rawInitData) {
    var fallbackUser = JSON.stringify({
      id: 1001,
      first_name: 'Alice',
      last_name: 'Chen',
      username: 'alice_tg',
      language_code: 'zh-hans',
      is_premium: true
    });
    var authDate = Math.floor(Date.now() / 1000);
    rawInitData =
      'query_id=AAHdF6IQAAAAAN0XohDhrOrc' +
      '&user=' + encodeURIComponent(fallbackUser) +
      '&auth_date=' + String(authDate) +
      '&hash=89d6079ad6762351f38c6dbbc41bb53048019256a9443988af7a48bcad16ba31';
  }

  var parsedInit = new URLSearchParams(rawInitData);
  var userObj = null;
  try {
    if (parsedInit.get('user')) {
      userObj = JSON.parse(parsedInit.get('user'));
    }
  } catch (_) {}

  var themeParams = Object.assign({}, NIGHT_THEME_PARAMS);
  try {
    var rawTheme = hashParams.get('tgWebAppThemeParams') || searchParams.get('tgWebAppThemeParams');
    if (rawTheme) {
      var parsedTheme = JSON.parse(rawTheme);
      if (parsedTheme && typeof parsedTheme === 'object') {
        Object.assign(themeParams, parsedTheme);
      }
    }
  } catch (_) {}

  var listeners = {};
  function emit(eventType, payload) {
    var arr = listeners[eventType] || [];
    for (var i = 0; i < arr.length; i++) {
      try {
        arr[i](payload);
      } catch (_) {}
    }
  }

  function postHost(eventType, eventData) {
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(
          JSON.stringify({ eventType: eventType, eventData: eventData || {} }),
          '*'
        );
      }
    } catch (_) {}
  }

  var pathParts = (window.location.pathname || '').split('/').filter(Boolean);
  // Supports both /miniapps/:bot/:app and /miniapps/:app/index.html
  var botUsername = 'FabushiBot';
  var shortName = 'fabushi-globe';
  if (pathParts.length >= 3 && pathParts[0] === 'miniapps' && pathParts[2] !== 'index.html') {
    botUsername = pathParts[1];
    shortName = pathParts[2].replace(/\.html$/i, '');
  } else if (pathParts.length >= 2 && pathParts[0] === 'miniapps') {
    shortName = pathParts[1].replace(/\.html$/i, '');
    botUsername = shortName.toLowerCase().indexOf('task') >= 0 ? 'TaskBoardBot' : 'FabushiBot';
  }

  var storageUrl =
    '/api/v1/miniapps/' +
    encodeURIComponent(botUsername) +
    '/' +
    encodeURIComponent(shortName) +
    '/cloud-storage';
  var sendDataUrl =
    '/api/v1/miniapps/' +
    encodeURIComponent(botUsername) +
    '/' +
    encodeURIComponent(shortName) +
    '/send-data';
  var localPrefix = 'tg_cloud_' + botUsername + '_' + shortName + ':';

  function localSet(key, val) {
    try {
      window.localStorage.setItem(localPrefix + key, String(val));
    } catch (_) {}
  }
  function localGet(key) {
    try {
      var v = window.localStorage.getItem(localPrefix + key);
      return v === null ? '' : v;
    } catch (_) {
      return '';
    }
  }
  function localRemove(key) {
    try {
      window.localStorage.removeItem(localPrefix + key);
    } catch (_) {}
  }
  function localKeys() {
    var out = [];
    try {
      for (var i = 0; i < window.localStorage.length; i++) {
        var k = window.localStorage.key(i);
        if (k && k.indexOf(localPrefix) === 0) {
          out.push(k.slice(localPrefix.length));
        }
      }
    } catch (_) {}
    return out;
  }

  // Optional in-frame fallback controls when host chrome does not render MainButton/BackButton
  var mainBtnEl = null;
  var backBtnEl = null;

  function syncInFrameButtons() {
    if (!document.body) return;

    if (BackButton.isVisible) {
      if (!backBtnEl) {
        backBtnEl = document.createElement('button');
        backBtnEl.id = 'tg-webapp-back-btn';
        backBtnEl.type = 'button';
        backBtnEl.setAttribute('data-testid', 'miniapp-back-btn');
        backBtnEl.setAttribute('aria-label', 'Back 返回');
        backBtnEl.textContent = '← Back';
        backBtnEl.style.cssText =
          'position:fixed;top:8px;left:8px;z-index:9999;padding:4px 10px;border-radius:8px;' +
          'border:1px solid #242F3D;background:#17212B;color:#F5F5F5;font-size:12px;cursor:pointer;';
        backBtnEl.addEventListener('click', function () {
          emit('backButtonClicked');
        });
        document.body.appendChild(backBtnEl);
      }
      backBtnEl.style.display = 'inline-flex';
    } else if (backBtnEl) {
      backBtnEl.style.display = 'none';
    }

    if (MainButton.isVisible) {
      if (!mainBtnEl) {
        mainBtnEl = document.createElement('button');
        mainBtnEl.id = 'tg-webapp-main-btn';
        mainBtnEl.type = 'button';
        mainBtnEl.setAttribute('data-testid', 'miniapp-main-btn');
        mainBtnEl.style.cssText =
          'position:fixed;left:12px;right:12px;bottom:10px;z-index:9999;padding:10px 16px;' +
          'border-radius:10px;border:none;font-size:14px;font-weight:600;cursor:pointer;';
        mainBtnEl.addEventListener('click', function () {
          if (MainButton.isActive) {
            emit('mainButtonClicked');
          }
        });
        document.body.appendChild(mainBtnEl);
      }
      mainBtnEl.textContent = MainButton.text;
      mainBtnEl.style.background = MainButton.color || '#3390EC';
      mainBtnEl.style.color = MainButton.textColor || '#FFFFFF';
      mainBtnEl.disabled = !MainButton.isActive;
      mainBtnEl.style.display = 'block';
    } else if (mainBtnEl) {
      mainBtnEl.style.display = 'none';
    }
  }

  var MainButton = {
    text: 'CONTINUE',
    color: '#3390EC',
    textColor: '#FFFFFF',
    isVisible: false,
    isActive: true,
    isProgressVisible: false,
    setText: function (t) {
      this.text = String(t);
      syncInFrameButtons();
      postHost('web_app_setup_main_button', {
        text: this.text,
        is_visible: this.isVisible,
        is_active: this.isActive,
        color: this.color,
        text_color: this.textColor
      });
      return this;
    },
    show: function () {
      this.isVisible = true;
      syncInFrameButtons();
      postHost('web_app_setup_main_button', {
        text: this.text,
        is_visible: true,
        is_active: this.isActive,
        color: this.color,
        text_color: this.textColor
      });
      return this;
    },
    hide: function () {
      this.isVisible = false;
      syncInFrameButtons();
      postHost('web_app_setup_main_button', {
        text: this.text,
        is_visible: false,
        is_active: this.isActive
      });
      return this;
    },
    enable: function () {
      this.isActive = true;
      syncInFrameButtons();
      return this;
    },
    disable: function () {
      this.isActive = false;
      syncInFrameButtons();
      return this;
    },
    showProgress: function () {
      this.isProgressVisible = true;
      return this;
    },
    hideProgress: function () {
      this.isProgressVisible = false;
      return this;
    },
    setParams: function (p) {
      if (!p) return this;
      if (p.text !== undefined) this.text = String(p.text);
      if (p.color) this.color = p.color;
      if (p.text_color) this.textColor = p.text_color;
      if (p.is_active !== undefined) this.isActive = Boolean(p.is_active);
      if (p.is_visible !== undefined) this.isVisible = Boolean(p.is_visible);
      syncInFrameButtons();
      postHost('web_app_setup_main_button', {
        text: this.text,
        is_visible: this.isVisible,
        is_active: this.isActive,
        color: this.color,
        text_color: this.textColor
      });
      return this;
    },
    onClick: function (cb) {
      WebApp.onEvent('mainButtonClicked', cb);
      return this;
    },
    offClick: function (cb) {
      WebApp.offEvent('mainButtonClicked', cb);
      return this;
    }
  };

  var BackButton = {
    isVisible: false,
    show: function () {
      this.isVisible = true;
      syncInFrameButtons();
      postHost('web_app_setup_back_button', { is_visible: true });
      return this;
    },
    hide: function () {
      this.isVisible = false;
      syncInFrameButtons();
      postHost('web_app_setup_back_button', { is_visible: false });
      return this;
    },
    onClick: function (cb) {
      WebApp.onEvent('backButtonClicked', cb);
      return this;
    },
    offClick: function (cb) {
      WebApp.offEvent('backButtonClicked', cb);
      return this;
    }
  };

  var CloudStorage = {
    setItem: function (key, value, cb) {
      var strVal = String(value);
      localSet(key, strVal);
      fetch(storageUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': rawInitData },
        body: JSON.stringify({ key: key, value: strVal })
      })
        .then(function () {
          if (cb) cb(null, true);
        })
        .catch(function () {
          if (cb) cb(null, true);
        });
    },
    getItem: function (key, cb) {
      fetch(storageUrl + '?keys=' + encodeURIComponent(key), {
        headers: { 'X-Telegram-Init-Data': rawInitData }
      })
        .then(function (r) {
          if (!r.ok) throw new Error('fallback');
          return r.json();
        })
        .then(function (d) {
          var val = d && d.items && d.items[key] !== undefined ? String(d.items[key]) : localGet(key);
          if (val) localSet(key, val);
          if (cb) cb(null, val);
        })
        .catch(function () {
          if (cb) cb(null, localGet(key));
        });
    },
    getItems: function (keys, cb) {
      var list = Array.isArray(keys) ? keys : [];
      fetch(storageUrl + '?keys=' + encodeURIComponent(list.join(',')), {
        headers: { 'X-Telegram-Init-Data': rawInitData }
      })
        .then(function (r) {
          if (!r.ok) throw new Error('fallback');
          return r.json();
        })
        .then(function (d) {
          var merged = {};
          for (var i = 0; i < list.length; i++) {
            var k = list[i];
            merged[k] = d && d.items && d.items[k] !== undefined ? String(d.items[k]) : localGet(k);
          }
          if (cb) cb(null, merged);
        })
        .catch(function () {
          var fallback = {};
          for (var i = 0; i < list.length; i++) {
            fallback[list[i]] = localGet(list[i]);
          }
          if (cb) cb(null, fallback);
        });
    },
    removeItem: function (key, cb) {
      localRemove(key);
      fetch(storageUrl + '?keys=' + encodeURIComponent(key), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': rawInitData },
        body: JSON.stringify({ keys: [key] })
      })
        .then(function () {
          if (cb) cb(null, true);
        })
        .catch(function () {
          if (cb) cb(null, true);
        });
    },
    removeItems: function (keys, cb) {
      var list = Array.isArray(keys) ? keys : [];
      for (var i = 0; i < list.length; i++) {
        localRemove(list[i]);
      }
      fetch(storageUrl, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': rawInitData },
        body: JSON.stringify({ keys: list })
      })
        .then(function () {
          if (cb) cb(null, true);
        })
        .catch(function () {
          if (cb) cb(null, true);
        });
    },
    getKeys: function (cb) {
      fetch(storageUrl, { headers: { 'X-Telegram-Init-Data': rawInitData } })
        .then(function (r) {
          if (!r.ok) throw new Error('fallback');
          return r.json();
        })
        .then(function (d) {
          var serverKeys = d && Array.isArray(d.keys) ? d.keys : [];
          var loc = localKeys();
          var seen = {};
          var merged = [];
          serverKeys.concat(loc).forEach(function (k) {
            if (k && !seen[k]) {
              seen[k] = true;
              merged.push(k);
            }
          });
          if (cb) cb(null, merged);
        })
        .catch(function () {
          if (cb) cb(null, localKeys());
        });
    }
  };

  window.addEventListener('message', function (ev) {
    try {
      var msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : ev.data;
      if (!msg || !msg.eventType) return;
      if (msg.eventType === 'main_button_pressed') {
        emit('mainButtonClicked');
      } else if (msg.eventType === 'back_button_pressed') {
        emit('backButtonClicked');
      } else if (msg.eventType === 'theme_changed' && msg.eventData) {
        Object.assign(WebApp.themeParams, msg.eventData.theme_params || {});
        emit('themeChanged', msg.eventData);
      } else {
        emit(msg.eventType, msg.eventData);
      }
    } catch (_) {}
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncInFrameButtons);
  }

  var WebApp = {
    initData: rawInitData,
    initDataUnsafe: {
      query_id: parsedInit.get('query_id') || 'AAHdF6IQAAAAAN0XohDhrOrc',
      user: userObj || { id: 1001, first_name: 'Alice', username: 'alice_tg', language_code: 'zh-hans' },
      auth_date: Number(parsedInit.get('auth_date') || Math.floor(Date.now() / 1000)),
      hash: parsedInit.get('hash') || '89d6079ad6762351f38c6dbbc41bb53048019256a9443988af7a48bcad16ba31'
    },
    version: '8.0',
    platform: 'weba',
    colorScheme: 'dark',
    themeParams: themeParams,
    isExpanded: true,
    viewportHeight: window.innerHeight || 640,
    viewportStableHeight: window.innerHeight || 640,
    MainButton: MainButton,
    BottomButton: MainButton,
    BackButton: BackButton,
    HapticFeedback: {
      impactOccurred: function (style) {
        postHost('web_app_trigger_haptic_feedback', { type: 'impact', impact_style: style || 'light' });
      },
      notificationOccurred: function (type) {
        postHost('web_app_trigger_haptic_feedback', { type: 'notification', notification_type: type || 'success' });
      },
      selectionChanged: function () {
        postHost('web_app_trigger_haptic_feedback', { type: 'selection_change' });
      }
    },
    CloudStorage: CloudStorage,
    ready: function () {
      syncInFrameButtons();
      postHost('web_app_ready', {});
    },
    expand: function () {
      this.isExpanded = true;
      postHost('web_app_expand', {});
    },
    close: function () {
      postHost('web_app_close', {});
    },
    sendData: function (dataStr) {
      var str = typeof dataStr === 'string' ? dataStr : JSON.stringify(dataStr);
      postHost('web_app_data_send', { data: str });
      return fetch(sendDataUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': rawInitData },
        body: JSON.stringify({ data: str })
      }).catch(function () {
        return { ok: true };
      });
    },
    onEvent: function (eventType, cb) {
      listeners[eventType] = listeners[eventType] || [];
      listeners[eventType].push(cb);
    },
    offEvent: function (eventType, cb) {
      listeners[eventType] = (listeners[eventType] || []).filter(function (fn) {
        return fn !== cb;
      });
    }
  };

  window.Telegram = window.Telegram || {};
  window.Telegram.WebApp = WebApp;
})();
