// Определение виртуального устройства для гиростата
defineVirtualDevice('script_hygrostat', {
    title: {en: 'Hydrostat', ru: 'Увлажнитель/Деуглеродный'},
    cells: {
        enable: {
            title: {en: 'Enable', ru: 'Включить'},
            type: 'switch',
            value: false
        },
        mode: {
            title: {en: 'Mode', ru: 'Режим'},
            type: 'pushbutton',
            value: 'humidifier',
            enum: {
                'humidifier': {en: 'Humidifier', ru: 'Увлажнитель'},
                'dehumidifier': {en: 'Dehumidifier', ru: 'Деуглеродный'}
            }
        },
        target: {
            title: {en: 'Target Humidity', ru: 'Целевая влажность'},
            type: 'range',
            value: 50,
            min: 20,
            max: 80,
            precision: 1
        },
        current: {
            title: {en: 'Current Humidity', ru: 'Текущая влажность'},
            type: 'value',
            value: 0
        },
        state: {
            title: {en: 'State', ru: 'Состояние'},
            type: 'value',
            value: 'off',
            enum: {
                'off': {en: 'Off', ru: 'Выключено'},
                'humidifying': {en: 'Humidifying', ru: 'Увлажняется'},
                'dehumidifying': {en: 'Dehumidifying', ru: 'Деуглеродится'},
                'idle': {en: 'Idle', ru: 'В ожидании'}
            }
        }
    }
});

// Логика управления гиростатом
function hygrostatLogic(id, stateChanged) {
    var topic = '/devices/' + id + '/controls/';
    var humidity = [];
    var relays = 0;
    var inverted = scripts[id].inverted;
    
    scripts[id].config.zones.forEach(function (zone, idx) {
        if (zone.sensor == 'disabled' || zone.relay == 'disabled') return;
        var humidityValue = dev[zone.sensor];
        var humidityError = (dev[zone.sensor + '#error'] == undefined) ? false : true;
        var relay = dev[zone.relay];
        if (!humidityValue) {
            humidityValue = 0.0;
            humidityError = true;
        }
        if (scripts[id].state == 'off' || humidityError) {
            relay = inverted;
        } else {
            var mode = scripts[id].mode;
            if (mode === 'humidifier') {
                if (humidityValue >= (scripts[id].target + scripts[id].config.hysteresis)) {
                    relay = inverted; // выключить
                } else if (humidityValue <= (scripts[id].target - scripts[id].config.hysteresis)) {
                    relay = !inverted; // включить
                }
            } else if (mode === 'dehumidifier') {
                if (humidityValue <= (scripts[id].target + scripts[id].config.hysteresis)) {
                    relay = inverted; // выключить
                } else if (humidityValue >= (scripts[id].target - scripts[id].config.hysteresis)) {
                    relay = !inverted; // включить
                }
            }
        }
        if (relay != inverted) relays++;
        var status = 'zone' + (idx + 1) + '_humidity_status';
        publish(topic + status, humidityValue, 0, true);
        publish(topic + status + '/meta/error', humidityError ? 'r' : '', 0, true);
    });
    if (scripts[id].state != 'off') {
        scripts[id].state = (relays > 0) ? scripts[id].mode + 'ing' : 'idle';
    }
    var current_humidity = humidity[0];
    if (humidity.length > 1) {
        current_humidity = humidity.reduce(function(x, y) { return x + y; }) / humidity.length;
    }
    publish(topic + 'current', current_humidity.round(1), 0, true);
    publish(topic + 'state', scripts[id].state, 0, true);
}

// Инициализация гиростата
function scriptHygrostatInit(script) {
    var id = "script_" + script['name'].fix();
    var enable = id + "/enable";
    var target = id + "/target";
    var topic = "/devices/" + id + "/controls/";
    if (typeof scripts[id] == 'undefined') {
        scripts[id] = {
            state: 'off',
            mode: script['mode'] || 'humidifier',
            inverted: false,
            sensors: [],
            sensorsErrors: [],
            target: script['humidity_target'] || script['humidity_min'],
            config: script
        };
        if (script['inverted_control'] === true) scripts[id].inverted = true;
    }
    if (dev[target]) scripts[id].target = dev[target];
    publish(topic + 'target', scripts[id].target, 0, true);
    if (dev[enable] || script.enabled) {
        scripts[id].state = 'idle';
        publish(topic + 'enable', 1, 0, true);
    } else {
        scripts[id].state = 'off';
        publish(topic + 'enable', 0, 0, true);
    }
    publish(topic + 'state', scripts[id].state, 0, true);
    log('wb-engine scriptHygrostatInit[{}]: mode={}, state={}, target={}', id, scripts[id].mode, scripts[id].state, scripts[id].target);
    
    // Регистрация триггеров
    trackMqtt(topic + '+/on', function(msg) { publish(msg.topic.replace('/on', ''), msg.value, 0, true); });
    trackMqtt(topic + 'mode/set', function(msg) {
        if (msg.value == 'off') {
            scripts[id].state = 'off';
            publish(topic + 'enable', 0, 0, true);
        } else {
            scripts[id].state = 'idle';
            publish(topic + 'enable', 1, 0, true);
        }
        hygrostatLogic(id, true);
    });
    // Обработка зон
    script.zones.forEach(function (zone, idx) {
        if (zone.sensor == 'disabled' || zone.relay == 'disabled') return;
        scripts[id].sensors[idx] = zone.sensor;
        scripts[id].sensorsErrors[idx] = zone.sensor + '#error';
    });
    // Определение правил
    defineRule(id + ".sensor-rule", { whenChanged: scripts[id].sensors, then: function() { hygrostatLogic(id); } });
    defineRule(id + ".error-rule", { whenChanged: scripts[id].sensorsErrors, then: function() { hygrostatLogic(id); } });
    defineRule(id + ".on-off-rule", { whenChanged: enable, then: function(value) { scripts[id].state = (value === true) ? 'idle' : 'off'; hygrostatLogic(id, true); } });
    defineRule(id + ".target-rule", { whenChanged: target, then: function(value) {
        if (value < scripts[id].config['humidity_min']) value = scripts[id].config['humidity_min'];
        if (value > scripts[id].config['humidity_max']) value = scripts[id].config['humidity_max'];
        scripts[id].target = value;
        hygrostatLogic(id);
    } });
    hygrostatLogic(id);
}
