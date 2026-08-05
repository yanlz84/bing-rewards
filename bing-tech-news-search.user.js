// ==UserScript==
// @name         Bing Rewards Search
// @namespace    http://tampermonkey.net/
// @version      1.7
// @description  在 Bing 上自动搜索 Noozra 科技新闻 + Rewards 每日签到与每日活动（3 个搜索），积累 Microsoft Rewards 积分
// @author       You
// @match        *://cn.bing.com/*
// @match        *://www.bing.com/*
// @match        *://rewards.bing.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @license      MIT
// ==/UserScript==

(function() {
    'use strict';

    // ============================================================
    //  配置
    // ============================================================
    const CONFIG = {
        // 每次搜索后等待时间范围（毫秒）
        minWait: 60 * 1000,   // 1 分钟
        maxWait: 120 * 1000,  // 2 分钟
        // 滚动间隔（毫秒）
        scrollInterval: 7 * 1000,
        // 连续多少次搜索积分未增长则停止
        noGrowthLimit: 3,
        // 自动启动时间（24小时制）
        autoStartHour: 4,
        autoStartMinute: 10,
        // Noozra Tech News API
        newsApi: 'https://noozra.com/api/articles?category=tech&limit=20',
        // 最多获取的新闻数
        maxItems: 20,
        // Bing 积分选择器列表（按优先级）
        pointSelectors: [
            // 当前 Bing 版本实际使用的选择器
            '.points-container',
            '#rh_rwm',
            '#id_rh_w',
            '#id_rc',
            '.meCRO_point',
            'span[aria-label*="point" i]',
            'span[aria-label*="积分" i]',
            '.meRewards',
            '.rewards_header',
            '#meBingRewards',
            '[class*="reward" i] span',
            '[id*="reward" i] span',
            '.rewardsPoints',
            '.reward_point',
            '#pointsBalance',
            '[data-reward-points]',
            'a[href*="rewards"] span',
            'a[href*="reward"] span',
            // cn.bing.com 特有的
            '#b_snowPlow',
            '#b_id_rc',
            '.sb_pointext',
            // 通用数值元素（距离 Rewards 链接最近的数字）
            '.id_proflink ~ span',
            '.id_proflink + span',
        ],
        // ===== Rewards 每日活动（签到 + 3 个搜索）配置 =====
        // rewards.bing.com dashboard 上的每日活动区域
        dailysetSection: '#dailyset',
        // 每日活动卡片链接（跳转到 Bing 搜索页，打开后自动上报完成）
        dailysetLink: 'a[href*="bing.com/search"]',
        // 已完成的链接文本标记（含此文本表示该活动已完成，跳过）
        dailysetDoneText: '已完成',
        // 未完成的活动链接文本标记（含 +10 表示待完成）
        dailysetPendingText: '+10',
        // 每个活动页停留时间（毫秒），等待 reportActivity 上报完成
        dailysetWaitMs: 6000,
        // 完成所有活动后返回的 dashboard 地址
        dashboardUrl: 'https://rewards.bing.com/dashboard?ref=rewardspanel',
    };

    // ============================================================
    //  状态管理（GM_setValue / GM_getValue）
    // ============================================================
    const STATE_KEYS = {
        videoQueue: 'videoQueue',
        currentIndex: 'currentIndex',
        startPoints: 'startPoints',
        points: 'points',
        status: 'status',
        noGrowthCount: 'noGrowthCount',
        pendingSearch: 'pendingSearch',
        currentSearchTerm: 'currentSearchTerm',
        autoStartTriggeredDate: 'autoStartTriggeredDate',  // 记录上次自动启动的日期，防止刷新后重复触发
        autoStartHour: 'autoStartHour',      // 自动启动-小时
        autoStartMinute: 'autoStartMinute',  // 自动启动-分钟
        // 每日活动（签到 + 3 个搜索）状态
        dailysetQueue: 'dailysetQueue',          // 待完成的活动链接队列
        dailysetIndex: 'dailysetIndex',          // 当前进行到第几个
        dailysetActive: 'dailysetActive',        // 每日活动流程是否进行中
        dailysetStartPoints: 'dailysetStartPoints',  // 开始时的积分，用于计算本次获得
        streakDays: 'streakDays',                // 每日连续打卡天数（缓存显示用）
    };

    function getState(key, defaultValue) {
        return GM_getValue(key, defaultValue);
    }

    function setState(key, value) {
        GM_setValue(key, value);
    }

    function resetState() {
        setState(STATE_KEYS.videoQueue, []);
        setState(STATE_KEYS.currentIndex, 0);
        setState(STATE_KEYS.startPoints, 0);
        setState(STATE_KEYS.points, 0);
        setState(STATE_KEYS.status, 'idle');
        setState(STATE_KEYS.noGrowthCount, 0);
        setState(STATE_KEYS.pendingSearch, false);
        setState(STATE_KEYS.currentSearchTerm, '');
        sessionStorage.removeItem('bili_pending');
    }

    // ============================================================
    //  UI 面板
    // ============================================================
    let panel = null;
    let livePointsDisplay = null;
    let startPointsDisplay = null;
    let currentPointsDisplay = null;
    let deltaDisplay = null;
    let statusDisplay = null;
    let btnStart = null;
    let btnStop = null;
    let streakDisplay = null;
    let dailysetDisplay = null;
    let btnDailySet = null;
    let manualInputRow = null;
    let manualInput = null;
    let manualBtn = null;
    let timeInput = null;
    let timeBtn = null;

    // 添加全局样式
    GM_addStyle(`
        #bing-bili-panel {
            position: fixed;
            top: 8px;
            right: 500px;
            z-index: 999999;
            background: rgba(30, 30, 30, 0.92);
            color: #fff;
            font-family: "Microsoft YaHei", Arial, sans-serif;
            font-size: 13px;
            padding: 10px 14px;
            border-radius: 8px;
            box-shadow: 0 2px 12px rgba(0,0,0,0.3);
            min-width: 200px;
            user-select: none;
            cursor: move;
            backdrop-filter: blur(4px);
            border: 1px solid rgba(255,255,255,0.1);
        }
        #bing-bili-panel .bili-title {
            font-weight: bold;
            font-size: 14px;
            margin-bottom: 6px;
            color: #4fc3f7;
        }
        #bing-bili-panel .bili-row {
            display: flex;
            justify-content: space-between;
            margin: 2px 0;
            gap: 8px;
        }
        #bing-bili-panel .bili-label {
            color: #aaa;
        }
        #bing-bili-panel .bili-value {
            color: #fff;
            font-weight: bold;
        }
        #bing-bili-panel .bili-delta {
            color: #81c784;
            font-weight: bold;
        }
        #bing-bili-panel .bili-status {
            margin-top: 6px;
            font-size: 12px;
            color: #ffd54f;
        }
        #bing-bili-panel .bili-actions {
            margin-top: 8px;
            display: flex;
            gap: 6px;
        }
        #bing-bili-panel .bili-btn {
            flex: 1;
            border: none;
            border-radius: 4px;
            padding: 4px 10px;
            font-size: 12px;
            cursor: pointer;
            transition: background 0.2s;
        }
        #bing-bili-panel .bili-btn-start {
            background: #4caf50;
            color: #fff;
        }
        #bing-bili-panel .bili-btn-start:hover {
            background: #43a047;
        }
        #bing-bili-panel .bili-btn-stop {
            background: #e53935;
            color: #fff;
        }
        #bing-bili-panel .bili-btn-stop:hover {
            background: #d32f2f;
        }
        #bing-bili-panel .bili-btn-daily {
            background: #ff9800;
            color: #fff;
        }
        #bing-bili-panel .bili-btn-daily:hover {
            background: #f57c00;
        }
        #bing-bili-panel .bili-btn-daily:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        #bing-bili-panel .bili-btn-start:disabled,
        #bing-bili-panel .bili-btn-stop:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        #bing-bili-panel .bili-input-row {
            display: none;
            margin-top: 6px;
            align-items: center;
            gap: 4px;
        }
        #bing-bili-panel .bili-input-row input {
            width: 80px;
            padding: 2px 4px;
            border-radius: 3px;
            border: 1px solid #555;
            background: #444;
            color: #fff;
            font-size: 12px;
        }
        #bing-bili-panel .bili-input-row .bili-btn {
            font-size: 11px;
            padding: 2px 6px;
        }
        #bing-bili-panel .bili-time-row {
            display: flex;
            align-items: center;
            gap: 4px;
            margin-top: 6px;
        }
        #bing-bili-panel .bili-time-row input[type="time"] {
            width: 90px;
            padding: 2px 4px;
            border-radius: 3px;
            border: 1px solid #555;
            background: #444;
            color: #fff;
            font-size: 12px;
        }
        #bing-bili-panel .bili-time-row .bili-btn {
            font-size: 11px;
            padding: 2px 6px;
        }
    `);

    function createPanel() {
        // 面板可能已存在（例如脚本被重复注入或旧版本残留），此时补全元素引用即可
        if (document.getElementById('bing-bili-panel')) {
            panel = document.getElementById('bing-bili-panel');
            livePointsDisplay = panel.querySelector('#bili-live-points');
            startPointsDisplay = panel.querySelector('#bili-start-points');
            currentPointsDisplay = panel.querySelector('#bili-current-points');
            deltaDisplay = panel.querySelector('#bili-delta-points');
            statusDisplay = panel.querySelector('#bili-status-text');
            btnStart = panel.querySelector('#bili-btn-start');
            btnStop = panel.querySelector('#bili-btn-stop');
            streakDisplay = panel.querySelector('#bili-streak');
            dailysetDisplay = panel.querySelector('#bili-dailyset');
            btnDailySet = panel.querySelector('#bili-btn-dailyset');
            manualInputRow = panel.querySelector('#bili-input-row');
            manualInput = panel.querySelector('#bili-manual-input');
            manualBtn = panel.querySelector('#bili-manual-btn');
            timeInput = panel.querySelector('#bili-time-input');
            timeBtn = panel.querySelector('#bili-time-btn');
            // 补挂每日活动按钮事件（防止重复绑定）
            if (btnDailySet && !btnDailySet._biliBound) {
                btnDailySet.addEventListener('click', onDailySetClick);
                btnDailySet._biliBound = true;
            }
            return;
        }

        panel = document.createElement('div');
        panel.id = 'bing-bili-panel';

        panel.innerHTML = `
            <div class="bili-title">🔍 Bing 自动搜索</div>
            <div class="bili-row">
                <span class="bili-label">Bing 积分:</span>
                <span class="bili-value" id="bili-live-points">检测中...</span>
            </div>
            <div class="bili-row">
                <span class="bili-label">起始积分:</span>
                <span class="bili-value" id="bili-start-points">0</span>
            </div>
            <div class="bili-row">
                <span class="bili-label">当前积分:</span>
                <span class="bili-value" id="bili-current-points">0</span>
            </div>
            <div class="bili-row">
                <span class="bili-label">增加:</span>
                <span class="bili-delta" id="bili-delta-points">+0</span>
            </div>
            <div class="bili-row">
                <span class="bili-label">每日打卡:</span>
                <span class="bili-value" id="bili-streak">-</span>
            </div>
            <div class="bili-row">
                <span class="bili-label">每日活动:</span>
                <span class="bili-value" id="bili-dailyset">-</span>
            </div>
            <div class="bili-status" id="bili-status-text">⏳ 检测中...</div>
            <div class="bili-actions">
                <button class="bili-btn bili-btn-start" id="bili-btn-start">▶ 开始</button>
                <button class="bili-btn bili-btn-stop" id="bili-btn-stop">■ 停止</button>
            </div>
            <div class="bili-actions" style="margin-top: 6px;">
                <button class="bili-btn bili-btn-daily" id="bili-btn-dailyset">🎯 签到+每日活动</button>
            </div>
            <div class="bili-input-row" id="bili-input-row">
                <span class="bili-label">手动输入:</span>
                <input type="number" id="bili-manual-input">
                <button class="bili-btn bili-btn-start" id="bili-manual-btn">确定</button>
            </div>
            <div class="bili-time-row" id="bili-time-row">
                <span class="bili-label">定时启动:</span>
                <input type="time" id="bili-time-input">
                <button class="bili-btn bili-btn-start" id="bili-time-btn">保存</button>
            </div>
        `;

        document.body.appendChild(panel);

        livePointsDisplay = panel.querySelector('#bili-live-points');
        startPointsDisplay = panel.querySelector('#bili-start-points');
        currentPointsDisplay = panel.querySelector('#bili-current-points');
        deltaDisplay = panel.querySelector('#bili-delta-points');
        statusDisplay = panel.querySelector('#bili-status-text');
        btnStart = panel.querySelector('#bili-btn-start');
        btnStop = panel.querySelector('#bili-btn-stop');
        streakDisplay = panel.querySelector('#bili-streak');
        dailysetDisplay = panel.querySelector('#bili-dailyset');
        btnDailySet = panel.querySelector('#bili-btn-dailyset');
        manualInputRow = panel.querySelector('#bili-input-row');
        manualInput = panel.querySelector('#bili-manual-input');
        manualBtn = panel.querySelector('#bili-manual-btn');
        timeInput = panel.querySelector('#bili-time-input');
        timeBtn = panel.querySelector('#bili-time-btn');

        btnStart.addEventListener('click', onStart);
        btnStop.addEventListener('click', onStop);
        btnDailySet.addEventListener('click', onDailySetClick);
        btnDailySet._biliBound = true;
        manualBtn.addEventListener('click', onManualPoints);
        timeBtn.addEventListener('click', onSaveTime);

        // 加载已保存的定时时间
        loadAutoStartTime();

        // 拖拽
        makeDraggable(panel);
    }

    function makeDraggable(el) {
        let isDown = false;
        let offsetX, offsetY;

        el.addEventListener('mousedown', function(e) {
            isDown = true;
            offsetX = e.clientX - el.getBoundingClientRect().left;
            offsetY = e.clientY - el.getBoundingClientRect().top;
            el.style.cursor = 'grabbing';
        });

        document.addEventListener('mousemove', function(e) {
            if (!isDown) return;
            e.preventDefault();
            let x = e.clientX - offsetX;
            let y = e.clientY - offsetY;
            x = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, x));
            y = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, y));
            el.style.left = x + 'px';
            el.style.right = 'auto';
            el.style.top = y + 'px';
        });

        document.addEventListener('mouseup', function() {
            isDown = false;
            el.style.cursor = 'move';
        });
    }

    function updateUI() {
        if (!panel) return;

        const sp = getState(STATE_KEYS.startPoints, 0);
        const cp = getState(STATE_KEYS.points, 0);
        const status = getState(STATE_KEYS.status, 'idle');
        const delta = cp - sp;

        if (livePointsDisplay) {
            // 如果尚未显示积分，立即尝试读取
            if (livePointsDisplay.textContent === '检测中...') {
                tryReadLivePoints();
            }
            // 有定时轮询（refreshLivePoints）持续刷新，此处不再重复读取
        }
        if (startPointsDisplay) startPointsDisplay.textContent = sp;
        if (currentPointsDisplay) currentPointsDisplay.textContent = cp;
        if (deltaDisplay) {
            deltaDisplay.textContent = delta >= 0 ? `+${delta}` : `${delta}`;
            deltaDisplay.style.color = delta > 0 ? '#81c784' : '#ff8a80';
        }

        if (statusDisplay) {
            const statusMap = {
                'idle': '⏹ 空闲中',
                'fetching': '📥 获取新闻列表...',
                'searching': '🔍 搜索中...',
                'waiting': '⏳ 等待间隔...',
                'done': '✅ 全部完成！',
                'stopped': '🛑 已停止',
                'noGrowth': '⚠️ 已停止：积分未增长',
            };
            statusDisplay.textContent = statusMap[status] || status;
        }

        if (btnStart) btnStart.disabled = (status === 'fetching' || status === 'searching' || status === 'waiting');
        if (btnStop) btnStop.disabled = (status === 'idle' || status === 'done' || status === 'stopped' || status === 'noGrowth');
    }

    // 尝试读取并显示当前 Bing 积分
    function tryReadLivePoints(retries) {
        retries = retries || 0;
        const points = isRewardsDashboard() ? readDashboardPoints() : readBingPoints();
        if (points !== null) {
            livePointsDisplay.textContent = points;
            livePointsDisplay.style.color = '#81c784';
            return true;
        } else if (retries < 5) {
            // 延迟重试（DOM 可能还没加载完）
            setTimeout(function() {
                tryReadLivePoints(retries + 1);
            }, 1500);
            return false;
        } else {
            livePointsDisplay.textContent = '未检测到';
            livePointsDisplay.style.color = '#ff8a80';
            // 显示手动输入框
            manualInputRow.style.display = 'flex';
            return false;
        }
    }

    function setStatus(statusText) {
        setState(STATE_KEYS.status, statusText);
        updateUI();
    }

    // 手动输入起始积分
    function onManualPoints() {
        const val = parseInt(manualInput.value, 10);
        if (isNaN(val) || val <= 0) {
            statusDisplay.textContent = '⚠️ 请输入有效数字';
            return;
        }
        setState(STATE_KEYS.startPoints, val);
        setState(STATE_KEYS.points, val);
        livePointsDisplay.textContent = val;
        manualInputRow.style.display = 'none';
        statusDisplay.textContent = `✅ 起始积分已设为 ${val}`;
        updateUI();
    }

    // ============================================================
    //  定时启动时间设置
    // ============================================================
    function getAutoStartHour() {
        return getState(STATE_KEYS.autoStartHour, CONFIG.autoStartHour);
    }

    function getAutoStartMinute() {
        return getState(STATE_KEYS.autoStartMinute, CONFIG.autoStartMinute);
    }

    function loadAutoStartTime() {
        const h = getAutoStartHour();
        const m = getAutoStartMinute();
        if (timeInput) {
            timeInput.value = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
        }
    }

    function onSaveTime() {
        if (!timeInput || !timeInput.value) {
            statusDisplay.textContent = '⚠️ 请选择时间';
            return;
        }
        const parts = timeInput.value.split(':');
        const h = parseInt(parts[0], 10);
        const m = parseInt(parts[1], 10);
        if (isNaN(h) || isNaN(m) || h < 0 || h > 23 || m < 0 || m > 59) {
            statusDisplay.textContent = '⚠️ 时间格式错误';
            return;
        }
        setState(STATE_KEYS.autoStartHour, h);
        setState(STATE_KEYS.autoStartMinute, m);
        statusDisplay.textContent = `✅ 定时启动已设为 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
        // 重置今天的触发标记，允许今天再次触发
        setState(STATE_KEYS.autoStartTriggeredDate, '');
        // 重启定时器
        startAutoStartTimer();
    }

    // ============================================================
    //  读取 Bing 积分
    // ============================================================
    function readBingPoints() {
        for (const selector of CONFIG.pointSelectors) {
            const el = document.querySelector(selector);
            if (el) {
                const text = el.textContent.trim();
                const match = text.match(/(\d[\d,]*)/);
                if (match) {
                    return parseInt(match[1].replace(/,/g, ''), 10);
                }
            }
        }
        // 尝试全局搜索所有可能包含积分的元素
        const allSpans = document.querySelectorAll('span, div, a');
        for (const el of allSpans) {
            const text = el.textContent.trim();
            // 寻找类似 "1234" 或 "1,234" 的数字，并且元素可见
            if (/^\d[\d,]*$/.test(text) && el.offsetWidth > 0 && el.offsetHeight > 0) {
                const num = parseInt(text.replace(/,/g, ''), 10);
                if (num > 0 && num < 100000) {
                    // 检查附近是否有"积分"或"point"字样
                    const parentText = (el.parentElement?.textContent || '').toLowerCase();
                    if (parentText.includes('积分') || parentText.includes('point') || parentText.includes('reward')) {
                        return num;
                    }
                }
            }
        }
        return null;
    }

    // ============================================================
    //  获取 Bilibili 热门视频
    // ============================================================
    function fetchNewsHeadlines() {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: CONFIG.newsApi,
                onload: function(res) {
                    try {
                        const data = JSON.parse(res.responseText);
                        if (data.articles && Array.isArray(data.articles)) {
                            const headlines = data.articles
                                .slice(0, CONFIG.maxItems)
                                .map(item => item.headline);
                            resolve(headlines);
                        } else {
                            reject(new Error('Noozra API 返回异常'));
                        }
                    } catch (e) {
                        reject(new Error('解析 Noozra 数据失败: ' + e.message));
                    }
                },
                onerror: function() {
                    reject(new Error('Noozra API 请求失败'));
                },
                ontimeout: function() {
                    reject(new Error('Noozra API 请求超时'));
                },
            });
        });
    }

    // ============================================================
    //  随机滚动
    // ============================================================
    let scrollTimer = null;
    let countdownTimer = null;
    let pointsTimer = null;
    let autoStartTimer = null;
    let autoStartTriggered = false;

    function startRandomScrolling() {
        stopRandomScrolling();
        const scroll = function() {
            const maxY = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
            if (maxY > 0) {
                const randomY = Math.floor(Math.random() * maxY);
                window.scrollTo({
                    top: randomY,
                    behavior: 'smooth',
                });
            }
        };
        scroll(); // 立即滚一次
        scrollTimer = setInterval(scroll, CONFIG.scrollInterval);
    }

    function stopRandomScrolling() {
        if (scrollTimer) {
            clearInterval(scrollTimer);
            scrollTimer = null;
        }
    }

    // ============================================================
    //  定时读取 Bing 积分
    // ============================================================
    function startPointsPolling() {
        stopPointsPolling();
        // 立即读取一次
        refreshLivePoints();
        // 每 10 秒重新读取
        pointsTimer = setInterval(refreshLivePoints, 10000);
    }

    function stopPointsPolling() {
        if (pointsTimer) {
            clearInterval(pointsTimer);
            pointsTimer = null;
        }
    }

    function refreshLivePoints() {
        const points = isRewardsDashboard() ? readDashboardPoints() : readBingPoints();
        if (points !== null && livePointsDisplay) {
            livePointsDisplay.textContent = points;
            livePointsDisplay.style.color = '#81c784';
            // 仅更新显示，不更新 STATE_KEYS.points
            // 轮询更新 STATE_KEYS.points 会导致下次搜索结果页的"积分未增长"误判
            const sp = getState(STATE_KEYS.startPoints, 0);
            const delta = points - sp;
            if (deltaDisplay) {
                deltaDisplay.textContent = delta >= 0 ? `+${delta}` : `${delta}`;
                deltaDisplay.style.color = delta > 0 ? '#81c784' : '#ff8a80';
            }
        }
        // dashboard 上周期刷新打卡/每日活动状态
        if (isRewardsDashboard()) {
            updateDashboardInfo();
        }
    }

    // ============================================================
    //  核心流程
    // ============================================================
    function onStart() {
        const status = getState(STATE_KEYS.status, 'idle');

        // 已停止/已完成状态允许重新开始 → 重置状态
        if (status === 'stopped' || status === 'done' || status === 'noGrowth') {
            resetState();
        } else if (status !== 'idle') {
            return; // 运行中不响应
        }

        // 隐藏手动输入框
        manualInputRow.style.display = 'none';

        setStatus('fetching');
        statusDisplay.textContent = '⏳ 正在读取 Bing 积分...';
        updateUI();

        // 重试读取积分（最多 5 次）
        tryReadStartPoints(0);
    }

    function tryReadStartPoints(retries) {
        const currentPoints = readBingPoints();
        if (currentPoints !== null) {
            setState(STATE_KEYS.startPoints, currentPoints);
            setState(STATE_KEYS.points, currentPoints);
            livePointsDisplay.textContent = currentPoints;
            livePointsDisplay.style.color = '#81c784';
            startFetchVideos();
            return;
        }

        // 尝试从 livePointsDisplay 取手动输入的值
        const liveVal = parseInt(livePointsDisplay.textContent, 10);
        if (!isNaN(liveVal) && liveVal > 0) {
            setState(STATE_KEYS.startPoints, liveVal);
            setState(STATE_KEYS.points, liveVal);
            startFetchVideos();
            return;
        }

        if (retries < 5) {
            statusDisplay.textContent = `⏳ 读取积分中 (${retries + 1}/5)...`;
            setTimeout(function() {
                tryReadStartPoints(retries + 1);
            }, 1500);
        } else {
            // 最终失败，显示手动输入
            statusDisplay.textContent = '⚠️ 未能自动读取积分，请手动输入';
            manualInputRow.style.display = 'flex';
            setStatus('idle');
            updateUI();
        }
    }

    function startFetchVideos() {
        setState(STATE_KEYS.noGrowthCount, 0);
        setStatus('fetching');
        updateUI();

        // 获取 Noozra 新闻标题
        fetchNewsHeadlines()
            .then(headlines => {
                if (headlines.length === 0) {
                    setStatus('idle');
                    updateUI();
                    return;
                }
                setState(STATE_KEYS.videoQueue, headlines);
                setState(STATE_KEYS.currentIndex, 0);
                setStatus('searching');
                updateUI();
                // 立即开始第一个搜索
                doNextSearch();
            })
            .catch(err => {
                statusDisplay.textContent = '❌ ' + err.message;
                setStatus('idle');
                updateUI();
            });
    }

    function onStop() {
        stopRandomScrolling();
        stopPointsPolling();
        if (countdownTimer) {
            clearInterval(countdownTimer);
            countdownTimer = null;
        }
        setStatus('stopped');
        updateUI();
    }

    // ============================================================
    //  搜索词随机缩减
    // ============================================================
    /**
     * 从字符串中移除随机位置开始的 n 个字符（n = 1~5），
     * 使每个搜索词略有不同，更接近人工搜索行为。
     */
    function randomReduceTitle(title) {
        const reduceBy = 1 + Math.floor(Math.random() * 5); // 1 ~ 5
        if (title.length <= reduceBy) {
            // 标题太短时只保留首字符，避免完全空串
            return title.length > 0 ? title[0] : title;
        }
        // 随机选择一个起始位置删除 reduceBy 个字符
        const startPos = Math.floor(Math.random() * (title.length - reduceBy));
        return title.substring(0, startPos) + title.substring(startPos + reduceBy);
    }

    function doNextSearch() {
        const queue = getState(STATE_KEYS.videoQueue, []);
        const index = getState(STATE_KEYS.currentIndex, 0);

        if (index >= queue.length) {
            stopRandomScrolling();
            setStatus('done');
            updateUI();
            return;
        }

        const title = queue[index];
        // 随机减少 1~5 个字符
        const reducedTitle = randomReduceTitle(title);
        setStatus('searching');
        updateUI();

        // 在状态区显示当前搜索标题
        if (statusDisplay) {
            statusDisplay.textContent = `🔍 搜索中 (${index + 1}/${queue.length}): ${reducedTitle.substring(0, 20)}...`;
        }

        // 保存搜索词，供回到主页后填入搜索框
        setState(STATE_KEYS.currentSearchTerm, reducedTitle);
        // 标记即将进行搜索（冗余标记：GM 状态 + sessionStorage）
        setState(STATE_KEYS.pendingSearch, true);
        sessionStorage.setItem('bili_pending', '1');

        // 先回到主页，再从主页执行搜索
        window.location.href = 'https://www.bing.com/';
    }

    // ============================================================
    //  在 Bing 主页填入搜索词并提交
    // ============================================================
    function performSearchFromHome() {
        const searchTerm = getState(STATE_KEYS.currentSearchTerm, '');
        if (!searchTerm) {
            setStatus('idle');
            updateUI();
            return;
        }

        // 查找搜索框并填入搜索词
        const searchInput = document.querySelector('#sb_form_q');
        if (searchInput) {
            searchInput.value = searchTerm;
            searchInput.dispatchEvent(new Event('input', { bubbles: true }));

            // 提交搜索
            const form = document.querySelector('#sb_form');
            if (form && typeof form.requestSubmit === 'function') {
                form.requestSubmit();
            } else {
                const searchBtn = document.querySelector('#sb_form_go')
                              || document.querySelector('#sb_search [type="submit"]')
                              || document.querySelector('#sb_form button[type="submit"]')
                              || document.querySelector('#sb_form .b_searchboxSubmit');
                if (searchBtn) {
                    searchBtn.click();
                } else if (form) {
                    form.submit();
                }
            }
        } else {
            // 主页上找不到搜索框，降级为 URL 跳转
            setState(STATE_KEYS.pendingSearch, false);
            sessionStorage.removeItem('bili_pending');
            const encodedTitle = encodeURIComponent(searchTerm);
            window.location.href = `https://www.bing.com/search?q=${encodedTitle}&bili_search=1`;
        }
    }

    // ============================================================
    //  页面加载后的处理（检查是否是从搜索跳转回来的）
    // ============================================================
    function onPageLoad() {
        // 每日活动流程优先处理（在 www.bing.com 上等待上报后继续下一个）
        if (handleDailySetFlow()) return;

        // 检查是否是在搜索结果页（URL 有 q= 参数）
        const url = new URL(window.location.href);
        const hasSearchQuery = url.searchParams.has('q');
        const biliSearchParam = url.searchParams.has('bili_search');
        const pendingFromGM = getState(STATE_KEYS.pendingSearch, false);
        const pendingFromSession = sessionStorage.getItem('bili_pending') === '1';
        // 如果状态是 searching/waiting 且 URL 有搜索词，极可能是我们的搜索返回
        const activeStatus = ['searching', 'waiting'].includes(getState(STATE_KEYS.status, ''));

        const isBiliSearch = biliSearchParam
                          || pendingFromGM
                          || pendingFromSession
                          || (hasSearchQuery && activeStatus);

        // 清除所有 pending 标记
        if (pendingFromGM) setState(STATE_KEYS.pendingSearch, false);
        if (pendingFromSession) sessionStorage.removeItem('bili_pending');

        if (!isBiliSearch) {
            // 普通页面加载（非搜索页面）
            const status = getState(STATE_KEYS.status, 'idle');
            if (status === 'searching' || status === 'waiting' || status === 'fetching') {
                // 流程中断：在活跃状态下来到了非搜索页面，停止所有计时器
                stopRandomScrolling();
                stopPointsPolling();
                if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
                setStatus('stopped');
            }
            updateUI();
            return;
        }

        // 来自新闻搜索跳转
        const status = getState(STATE_KEYS.status, '');
        if (status === 'done' || status === 'stopped' || status === 'noGrowth') {
            updateUI();
            return;
        }

        if (!hasSearchQuery) {
            // 在主页上：填入搜索词并提交
            performSearchFromHome();
            return;
        }

        // 防止在等待间隔期间刷新页面导致重复计数
        if (status === 'waiting') {
            updateUI();
            return;
        }

        // 等待搜索结果加载完成
        waitForSearchResults()
            .then(() => {
                // 清理等待标记
                delete document.body.dataset.biliWaitAttempts;
                // 读取当前 Bing 积分
                const currentBingPoints = readBingPoints();
                const savedPoints = getState(STATE_KEYS.points, 0);
                const startPoints = getState(STATE_KEYS.startPoints, 0);
                const index = getState(STATE_KEYS.currentIndex, 0);
                const queue = getState(STATE_KEYS.videoQueue, []);
                let noGrowthCount = getState(STATE_KEYS.noGrowthCount, 0);

                if (currentBingPoints !== null) {
                    if (currentBingPoints > savedPoints) {
                        // 积分增长了，重置计数器
                        noGrowthCount = 0;
                    } else {
                        // 积分未增长
                        noGrowthCount++;
                    }
                    setState(STATE_KEYS.points, currentBingPoints);
                } else {
                    // 无法读取积分，保守处理：不增长计数器
                    statusDisplay.textContent = '⚠️ 未能读取积分';
                }

                setState(STATE_KEYS.noGrowthCount, noGrowthCount);
                setState(STATE_KEYS.currentIndex, index + 1);

                // 检查是否达到未增长上限
                if (noGrowthCount >= CONFIG.noGrowthLimit) {
                    stopPointsPolling();
                    stopRandomScrolling();
                    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
                    setStatus('noGrowth');
                    updateUI();
                    statusDisplay.textContent = `⚠️ 已停止：连续 ${noGrowthCount} 次搜索积分未增长`;
                    return;
                }

                // 检查是否全部完成
                if (index + 1 >= queue.length) {
                    stopPointsPolling();
                    stopRandomScrolling();
                    if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
                    setStatus('done');
                    updateUI();
                    statusDisplay.textContent = '✅ 全部完成！超棒！';
                    return;
                }

                // 等待随机间隔，然后继续（显示实时倒数）
                const waitTime = CONFIG.minWait + Math.floor(Math.random() * (CONFIG.maxWait - CONFIG.minWait));
                setStatus('waiting');
                updateUI();

                let remaining = Math.round(waitTime / 1000);
                statusDisplay.textContent = `⏳ 等待 ${remaining} 秒后继续...`;

                // 等待期间随机滚动
                startRandomScrolling();

                // 每秒更新倒数
                if (countdownTimer) clearInterval(countdownTimer);
                countdownTimer = setInterval(() => {
                    remaining--;
                    if (remaining > 0) {
                        statusDisplay.textContent = `⏳ 等待 ${remaining} 秒后继续...`;
                    } else {
                        clearInterval(countdownTimer);
                        countdownTimer = null;
                        stopRandomScrolling();
                        doNextSearch();
                    }
                }, 1000);
            })
            .catch(() => {
                // 搜索页面加载异常，过一会重试
                statusDisplay.textContent = '⚠️ 页面加载异常，3秒后重试...';
                setTimeout(doNextSearch, 3000);
            });
    }

    function waitForSearchResults() {
        return new Promise((resolve) => {
            // 等待搜索结果中的关键元素出现
            const check = function() {
                const results = document.querySelector('#b_results') ||
                               document.querySelector('.b_caption') ||
                               document.querySelector('#search_results') ||
                               document.querySelector('[data-async-context*="search"]');
                if (results) {
                    resolve();
                } else {
                    // 最多等待 15 秒
                    const attempts = parseInt(document.body.dataset.biliWaitAttempts || '0');
                    if (attempts > 30) {
                        resolve(); // 超时也继续
                    }
                    document.body.dataset.biliWaitAttempts = String(attempts + 1);
                    setTimeout(check, 500);
                }
            };
            setTimeout(check, 1000);
        });
    }

    // ============================================================
    //  凌晨 1 点自动启动
    // ============================================================
    function checkAutoStart() {
        const now = new Date();
        const hour = now.getHours();
        const minute = now.getMinutes();
        const status = getState(STATE_KEYS.status, 'idle');
        const targetH = getAutoStartHour();
        const targetM = getAutoStartMinute();
        const targetTime = `${String(targetH).padStart(2, '0')}:${String(targetM).padStart(2, '0')}`;
        console.log(`[AutoStart] 立即检查: ${hour}:${minute}, 目标时间=${targetTime}, status=${status}, 今天已触发=${hasAutoStartedToday()}`);

        if (hasAutoStartedToday()) {
            console.log('[AutoStart] 今天已触发过，跳过');
            return;
        }

        if (hour === targetH && minute >= targetM && minute <= targetM + 1) {
            if (statusDisplay) {
                // 只有空闲/结束状态才允许自动启动，避免打断正在运行的任务
                if (status !== 'idle' && status !== 'done' && status !== 'stopped' && status !== 'noGrowth') {
                    console.log(`[AutoStart] 时间到但任务运行中 (status=${status})，跳过`);
                    return;
                }
                console.log('[AutoStart] ✅ 立即检查条件满足，2秒后启动');
                markAutoStartedToday();
                if (status !== 'idle') {
                    resetState();
                }
                statusDisplay.textContent = `⏰ ${targetTime}，自动启动...`;
                setTimeout(onStart, 2000);
            } else {
                console.log('[AutoStart] ⏳ 时间到但 statusDisplay 未就绪');
            }
        } else {
            console.log(`[AutoStart] 不在自动启动时间窗口 (当前 ${hour}:${minute})`);
        }
    }

    /**
     * 检查今天是否已经自动启动过（用 GM 持久化，页面刷新后不会重复触发）
     */
    function getTodayString() {
        const now = new Date();
        return now.getFullYear() + '-' +
            String(now.getMonth() + 1).padStart(2, '0') + '-' +
            String(now.getDate()).padStart(2, '0');
    }

    function hasAutoStartedToday() {
        const lastDate = getState(STATE_KEYS.autoStartTriggeredDate, '');
        return lastDate === getTodayString();
    }

    function markAutoStartedToday() {
        setState(STATE_KEYS.autoStartTriggeredDate, getTodayString());
    }

    /**
     * 启动定时检测：每 30 秒检查一次，到达指定时间时自动触发。
     * 页面只要开着就会持续检测，不依赖页面刷新。
     */
    function startAutoStartTimer() {
        stopAutoStartTimer();
        const targetH = getAutoStartHour();
        const targetM = getAutoStartMinute();
        const targetTime = `${String(targetH).padStart(2, '0')}:${String(targetM).padStart(2, '0')}`;
        console.log(`[AutoStart] 定时器已启动，每 30 秒检查一次，目标时间 ${targetTime}，今天已触发: ${hasAutoStartedToday()}`);

        // 每 30 秒检查一次
        autoStartTimer = setInterval(function() {
            const now = new Date();
            const hour = now.getHours();
            const minute = now.getMinutes();
            const status = getState(STATE_KEYS.status, 'idle');
            console.log(`[AutoStart] 检查: ${hour}:${minute}, status=${status}, 今天已触发=${hasAutoStartedToday()}`);

            if (hasAutoStartedToday()) {
                console.log('[AutoStart] 今天已触发过，停止定时器');
                stopAutoStartTimer();
                return;
            }

            if (hour === targetH && minute >= targetM && minute <= targetM + 1) {
                if (statusDisplay) {
                    // 只有空闲/结束状态才允许自动启动，避免打断正在运行的任务
                    if (status !== 'idle' && status !== 'done' && status !== 'stopped' && status !== 'noGrowth') {
                        console.log(`[AutoStart] 时间到但任务运行中 (status=${status})，跳过`);
                        return;
                    }
                    console.log('[AutoStart] ✅ 条件满足，触发自动启动');
                    markAutoStartedToday();
                    stopAutoStartTimer();
                    if (status !== 'idle') {
                        resetState();
                    }
                    statusDisplay.textContent = `⏰ ${targetTime}，自动启动...`;
                    setTimeout(onStart, 2000);
                } else {
                    console.log('[AutoStart] ⏳ 时间到但 statusDisplay 未就绪');
                }
            }
        }, 30000);

        // 同时立即检查一次（防止刚好在目标时间打开页面但错过了窗口）
        checkAutoStart();
    }

    function stopAutoStartTimer() {
        if (autoStartTimer) {
            clearInterval(autoStartTimer);
            autoStartTimer = null;
        }
    }

    // ============================================================
    //  Rewards 每日活动（签到 + 3 个搜索）
    // ============================================================
    /**
     * 判断当前页面是否为 rewards.bing.com 仪表盘
     */
    function isRewardsDashboard() {
        const host = window.location.hostname;
        return host === 'rewards.bing.com' || host.endsWith('.rewards.bing.com');
    }

    /**
     * 读取 dashboard 上的积分（"可用积分"卡片 → 顶栏 header → 个人资料按钮）
     */
    function readDashboardPoints() {
        // "可用积分"兑换链接（最可靠）
        const redeemLink = [...document.querySelectorAll('a[href*="/redeem"]')].find(a => a.textContent.includes('可用积分'));
        if (redeemLink) {
            const m = redeemLink.textContent.match(/(\d[\d,]*)/);
            if (m) return parseInt(m[1].replace(/,/g, ''), 10);
        }
        // 顶栏 header / banner 中的第一个数字
        const header = document.querySelector('header, [class*="banner" i]');
        if (header) {
            const m = header.textContent.match(/(\d[\d,]*)/);
            if (m) return parseInt(m[1].replace(/,/g, ''), 10);
        }
        // 顶栏个人资料按钮
        const profileBtn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('查看个人资料'));
        if (profileBtn) {
            const m = profileBtn.textContent.match(/(\d[\d,]*)/);
            if (m) return parseInt(m[1].replace(/,/g, ''), 10);
        }
        return null;
    }

    /**
     * 更新面板上的每日打卡天数与每日活动进度
     */
    function updateDashboardInfo() {
        if (!streakDisplay || !dailysetDisplay) return;

        // 每日连续打卡天数（"你的进度"区域）
        const streakBtn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('每日连续打卡'));
        if (streakBtn) {
            const m = streakBtn.textContent.match(/(\d[\d,]*)\s*天/);
            const days = m ? m[1] : '未知';
            streakDisplay.textContent = days + ' 天';
            setState(STATE_KEYS.streakDays, days);
        } else {
            // 非 dashboard 页面显示缓存值
            const cached = getState(STATE_KEYS.streakDays, '');
            if (cached) streakDisplay.textContent = cached + ' 天';
        }

        // 每日活动进度（"活动"区域：活动: x/3）
        const progBtn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('每日活动') && b.textContent.includes('活动:'));
        if (progBtn) {
            // 只匹配叶子文本元素（无子元素），避免与徽章数字拼接（如"2/3"+"6"→"2/36"）
            const textEl = [...progBtn.querySelectorAll('p, span, div')]
                .find(el => el.children.length === 0 && /^\s*活动:\s*\d+\s*\/\s*\d+\s*$/.test(el.textContent));
            const m = (textEl ? textEl.textContent : progBtn.textContent)
                .match(/活动:\s*(\d+)\s*\/\s*(\d+)/);
            if (m) {
                dailysetDisplay.textContent = m[1] + '/' + m[2];
            }
        }
    }

    /**
     * 点击"签到+每日活动"按钮
     * 不在 dashboard 时先跳转到 dashboard 并带启动参数
     */
    function onDailySetClick() {
        if (!isRewardsDashboard()) {
            statusDisplay.textContent = '🚀 正在打开 Rewards 仪表盘...';
            window.location.href = CONFIG.dashboardUrl + '&dailyset_start=1';
            return;
        }
        startDailySet();
    }

    /**
     * 启动每日活动流程：
     * 1. 收集 #dailyset 中未完成的活动链接
     * 2. 依次跳转打开，Bing 搜索页加载后自动上报完成
     */
    function startDailySet() {
        // 新闻搜索流程进行中时不允许同时运行
        const status = getState(STATE_KEYS.status, 'idle');
        if (status === 'searching' || status === 'waiting' || status === 'fetching') {
            statusDisplay.textContent = '⚠️ 新闻搜索运行中，请先停止再执行每日活动';
            return;
        }

        const section = document.querySelector(CONFIG.dailysetSection);
        if (!section) {
            statusDisplay.textContent = '⚠️ 未找到每日活动区域（#dailyset）';
            return;
        }

        // 收集未完成的活动链接（已完成的含"已完成"文本，跳过）
        const links = [...section.querySelectorAll(CONFIG.dailysetLink)]
            .filter(a => !a.textContent.includes(CONFIG.dailysetDoneText))
            .map(a => a.href);

        if (links.length === 0) {
            statusDisplay.textContent = '✅ 今日每日活动已全部完成！';
            updateDashboardInfo();
            return;
        }

        // 记录起始积分
        const pts = readDashboardPoints() || readBingPoints();
        if (pts) setState(STATE_KEYS.dailysetStartPoints, pts);

        setState(STATE_KEYS.dailysetQueue, links);
        setState(STATE_KEYS.dailysetIndex, 0);
        setState(STATE_KEYS.dailysetActive, true);

        statusDisplay.textContent = `🎯 每日活动开始，还有 ${links.length} 个未完成`;
        updateUI();

        // 跳转到第一个活动链接（Bing 搜索页会自动上报完成）
        window.location.href = links[0];
    }

    /**
     * 搜索页上的每日活动流程（在 www.bing.com 上执行）：
     * 等待当前活动上报完成后，跳转下一个活动或返回 dashboard。
     * 返回 true 表示已处理（当前处于每日活动流程中）。
     */
    function handleDailySetFlow() {
        const active = getState(STATE_KEYS.dailysetActive, false);
        if (!active) return false;

        const queue = getState(STATE_KEYS.dailysetQueue, []);
        const index = getState(STATE_KEYS.dailysetIndex, 0);
        if (!Array.isArray(queue) || queue.length === 0) {
            setState(STATE_KEYS.dailysetActive, false);
            return false;
        }

        if (statusDisplay) {
            statusDisplay.textContent = `🎯 每日活动 (${index + 1}/${queue.length}) 上报中，稍后自动继续...`;
        }
        // 避免与新闻搜索流程冲突：暂停新闻搜索的积分轮询和滚动
        stopRandomScrolling();
        stopPointsPolling();
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }

        // 等待 reportActivity 上报完成，然后继续下一个
        const waitMs = CONFIG.dailysetWaitMs || 6000;
        setTimeout(() => {
            const next = index + 1;
            if (next >= queue.length) {
                // 全部完成 → 返回 dashboard 查看结果
                setState(STATE_KEYS.dailysetActive, false);
                setState(STATE_KEYS.dailysetQueue, []);
                window.location.href = CONFIG.dashboardUrl + '&dailyset_done=1';
            } else {
                setState(STATE_KEYS.dailysetIndex, next);
                window.location.href = queue[next];
            }
        }, waitMs);

        return true;
    }

    /**
     * rewards.bing.com 仪表盘初始化：
     * 显示打卡/活动状态，处理 URL 启动/完成参数
     */
    function initDashboard() {
        // 显示打卡天数和每日活动进度
        updateDashboardInfo();

        // 尝试读取积分
        const pts = readDashboardPoints();
        if (pts !== null && livePointsDisplay) {
            livePointsDisplay.textContent = pts;
            livePointsDisplay.style.color = '#81c784';
        }

        const url = new URL(window.location.href);

        // 处理"启动每日活动"参数（从其他页面点按钮跳转过来）
        if (url.searchParams.has('dailyset_start')) {
            url.searchParams.delete('dailyset_start');
            history.replaceState(null, '', url.toString());
            setTimeout(startDailySet, 800);
            return;
        }

        // 处理"每日活动完成"参数（从搜索页跳回）
        if (url.searchParams.has('dailyset_done')) {
            url.searchParams.delete('dailyset_done');
            history.replaceState(null, '', url.toString());

            const start = getState(STATE_KEYS.dailysetStartPoints, 0);
            const now = readDashboardPoints();
            let msg = '✅ 每日活动完成！打卡成功！';
            if (now && start && now > start) {
                msg = `✅ 每日活动完成！本次 +${now - start} 积分，打卡成功！`;
            }
            statusDisplay.textContent = msg;

            // 刷新状态显示
            setTimeout(updateDashboardInfo, 1500);
            return;
        }
    }

    // ============================================================
    //  初始化
    // ============================================================
    function init() {
        createPanel();

        // 立即尝试读取并启动定时轮询（每 10 秒刷新积分）
        tryReadLivePoints(0);
        startPointsPolling();

        // 启动凌晨 1 点自动检测（每 30 秒检查一次）
        startAutoStartTimer();

        updateUI();

        // rewards.bing.com 仪表盘：每日签到 + 每日活动
        if (isRewardsDashboard()) {
            initDashboard();
            return;
        }

        // 等待 DOM 稳定后执行页面加载逻辑
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', onPageLoad);
        } else {
            onPageLoad();
        }
    }

    // 等待 DOM 就绪
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
