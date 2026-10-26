'use strict';
'require view';
'require form';
'require rpc';
'require uci';
'require ui';
'require fs';

var callStatus = rpc.declare({
	object: 'homepanel',
	method: 'status',
	expect: {
		configured: false,
		enabled: false,
		last_send: 0,
		client_count: 0,
		version: '',
		last_error: null,
		watcher: false,
		nft: false,
		last_control_error: null
	}
});
var callSend = rpc.declare({ object: 'homepanel', method: 'send' });

function fmtTime(ts) {
	if (!ts)
		return _('—');
	return new Date(ts * 1000).toLocaleString();
}

return view.extend({
	load: function() {
		return uci.load('homepanel');
	},

	render: function() {
		var self = this;
		var m, s, o;

		m = new form.Map('homepanel', _('Home Panel'),
			_('Агент отправляет список подключённых WiFi-клиентов на сервер панели.'));

		s = m.section(form.NamedSection, 'main', 'homepanel', _('Настройки агента'));
		s.anonymous = true;
		s.addremove = false;

		o = s.option(form.Flag, 'enabled', _('Включено'));
		o.default = '1';
		o.rmempty = false;

		o = s.option(form.Value, 'server_url', _('Адрес сервера'));
		o.placeholder = 'https://homepanel.example.com/api/ingest';
		o.description = _('Полный URL эндпоинта /api/ingest на сервере.');

		o = s.option(form.Value, 'secret', _('Секрет'));
		o.password = true;
		o.description = _('Должен совпадать с secret в config.json сервера.');

		o = s.option(form.Value, 'interval', _('Интервал, с'));
		o.datatype = 'uinteger';
		o.default = '20';

		o = s.option(form.Flag, 'wired', _('Проводные клиенты'));
		o.default = '1';
		o.description = _('Собирать клиентов из bridge FDB и ARP.');

		o = s.option(form.Flag, 'control', _('Управление'));
		o.default = '1';
		o.description = _('Применять паузы и команды с сервера.');

		o = s.option(form.Flag, 'events', _('Мгновенные события'));
		o.default = '1';
		o.description = _('Отправлять снимок при подключении или отключении WiFi-клиента.');

		var panel = E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('Статус агента')),
			E('div', { 'id': 'homepanel-status' }, [ E('em', {}, _('Загрузка…')) ]),
			E('div', { 'class': 'cbi-page-actions' }, [
				E('button', {
					'type': 'button',
					'class': 'btn cbi-button cbi-button-apply',
					'click': ui.createHandlerFn(self, 'handleSend')
				}, _('Отправить сейчас')),
				' ',
				E('button', {
					'type': 'button',
					'class': 'btn cbi-button',
					'click': ui.createHandlerFn(self, 'handleRefresh')
				}, _('Обновить'))
			])
		]);

		return m.render().then(function(node) {
			node.appendChild(panel);
			self.refreshStatus();
			self._timer = window.setInterval(function() {
				self.refreshStatus();
			}, 10000);
			return node;
		});
	},

	refreshStatus: function() {
		var el = document.getElementById('homepanel-status');
		if (!el)
			return Promise.resolve();

		return callStatus().then(function(st) {
			if (st && st.version && !st.error)
				return st;
			return fs.read('/tmp/homepanel.status').then(function(raw) {
				try { return JSON.parse(raw); } catch (e) { return st || {}; }
			}, function() { return st || {}; });
		}).then(function(st) {
			var rows = [
				[ _('Настроен'), st.configured ? _('да') : _('нет') ],
				[ _('Включён'), st.enabled ? _('да') : _('нет') ],
				[ _('Последняя отправка'), fmtTime(st.last_send) ],
				[ _('Клиентов в снимке'), String(st.client_count || 0) ],
				[ _('Версия агента'), st.version || '—' ],
				[ _('Наблюдатель событий'), st.watcher ? _('работает') : _('остановлен') ],
				[ _('nftables'), st.nft ? _('доступен') : _('нет') ],
				[ _('Последняя ошибка управления'), st.last_control_error || _('нет') ],
				[ _('Последняя ошибка'), st.last_error || _('нет') ]
			];

			el.innerHTML = '';
			el.appendChild(E('table', { 'class': 'table' }, rows.map(function(r) {
				return E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td left', 'width': '30%' }, [ E('strong', {}, r[0]) ]),
					E('td', { 'class': 'td left' }, [ r[1] ])
				]);
			})));
		}).catch(function(e) {
			el.innerHTML = '';
			el.appendChild(E('em', {}, _('Не удалось получить статус: %s').format(e.message || e)));
		});
	},

	handleRefresh: function() {
		return this.refreshStatus();
	},

	handleSend: function() {
		var self = this;
		return callSend().then(function(res) {
			ui.addNotification(null, E('p', {},
				res && res.ok ? _('Снимок отправлен.') : _('Отправка не удалась.')),
				res && res.ok ? 'info' : 'error');
			return self.refreshStatus();
		}).catch(function(e) {
			ui.addNotification(null, E('p', {}, _('Ошибка: %s').format(e.message || e)), 'error');
		});
	},

	destroy: function() {
		if (this._timer) {
			window.clearInterval(this._timer);
			this._timer = null;
		}
	}
});
