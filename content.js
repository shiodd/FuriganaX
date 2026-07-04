// ============================================================
// X 振り仮名 - Content Script
// 在 X.com 推文中注入"振仮名"按钮，处理标注逻辑
// ============================================================

const BUTTON_LABEL = '仮';
const ACTIVE_CLASS = 'jpfurigana-active';
const EXTENSION_ID = chrome.runtime.id;
const INJECT_SRC = `chrome-extension://${EXTENSION_ID}/inject.js`;

// ---- 注入 kuromoji 分析脚本到页面上下文 ----
function injectAnalyzer() {
  if (document.querySelector('script[data-jpfurigana]')) return;

  const script = document.createElement('script');
  script.src = INJECT_SRC;
  script.dataset.jpfurigana = '1';
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

// ---- 判断是否为日文文本（含汉字/假名） ----
function isJapaneseText(text) {
  return /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uffef\u4e00-\u9faf\u3400-\u4dbf]/.test(text);
}

// ---- 获取推文文本内容 ----
function getTweetText(tweetElement) {
  // 优先选择 data-testid="tweetText" 元素
  const textEl = tweetElement.querySelector('[data-testid="tweetText"]');
  if (!textEl) return '';

  // 遍历文本节点，排除已标注的 ruby 内容
  const parts = [];
  const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT, null, false);
  let node;
  while ((node = walker.nextNode())) {
    // 跳过已标注的 ruby 内部文本
    if (node.parentElement?.closest?.('ruby')) continue;
    parts.push(node.textContent);
  }

  const text = parts.join('');
  return text;
}

// ---- 添加 ruby 标注到推文中（保留已有 HTML 元素：链接、emoji 等） ----
function applyFurigana(tweetElement, words) {
  const textEl = tweetElement.querySelector('[data-testid="tweetText"]');
  if (!textEl) return;

  clearFurigana(tweetElement);

  // 收集所有文本节点，记录每个节点在合并文本中的起止位置
  const textNodes = [];
  const ranges = []; // { node, start, end }
  let offset = 0;
  const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest?.('ruby')) continue;
    const len = node.textContent.length;
    if (len === 0) continue;
    textNodes.push(node);
    ranges.push({ node, start: offset, end: offset + len });
    offset += len;
  }
  if (textNodes.length === 0) return;

  // 将 words 中需要标注的词定位到文本节点（按节点索引分组）
  const repl = new Map(); // nodeIndex -> [{start, end, kanji, kana}]
  let pos = 0;
  for (const w of words) {
    if (w.kanji && w.kana) {
      const wLen = w.kanji.length;
      for (let i = 0; i < ranges.length; i++) {
        const r = ranges[i];
        if (pos >= r.end || pos + wLen <= r.start) continue;
        const s = Math.max(pos, r.start) - r.start;
        const e = Math.min(pos + wLen, r.end) - r.start;
        if (e <= s) continue;
        const ks = w.kanji.slice(Math.max(r.start - pos, 0), wLen - Math.max(pos + wLen - r.end, 0));
        if (!repl.has(i)) repl.set(i, []);
        repl.get(i).push({ start: s, end: e, kanji: ks, kana: w.kana });
      }
    }
    pos += (w.text || w.kanji || '').length;
  }

  // 逐个文本节点，从右到左用 splitText 插入 ruby
  for (const [idx, reps] of repl) {
    reps.sort((a, b) => b.start - a.start);
    let tn = textNodes[idx];
    for (const r of reps) {
      const after = tn.splitText(r.end);
      const kanjiNode = tn.splitText(r.start);
      const ruby = document.createElement('ruby');
      ruby.className = 'jpfurigana-ruby';
      ruby.textContent = r.kanji;
      const rt = document.createElement('rt');
      rt.className = 'jpfurigana-rt';
      rt.textContent = r.kana;
      ruby.appendChild(rt);
      kanjiNode.parentNode.replaceChild(ruby, kanjiNode);
    }
  }

  textEl.dataset.jpfurigana = '1';
}

// ---- 清除标注（只移除 ruby，保留链接/emoji 等 HTML 元素） ----
function clearFurigana(tweetElement) {
  const textEl = tweetElement.querySelector('[data-testid="tweetText"]');
  if (!textEl) return;
  if (textEl.dataset.jpfurigana !== '1') return;

  const rubies = textEl.querySelectorAll('ruby.jpfurigana-ruby');
  for (let i = rubies.length - 1; i >= 0; i--) {
    const ruby = rubies[i];
    const rt = ruby.querySelector('rt');
    const kanji = rt ? ruby.textContent.replace(rt.textContent, '') : ruby.textContent;
    ruby.replaceWith(document.createTextNode(kanji));
  }
  delete textEl.dataset.jpfurigana;
}

// ---- 为推文添加按钮 ----
function addButtonToTweet(tweetElement) {
  if (tweetElement.querySelector('.jpfurigana-btn')) return;

  // 定位推文顶部的「更多」按钮(⋯)，我们的按钮放它左边
  const moreBtn = tweetElement.querySelector(
    'button[aria-label="More"], button[data-testid="caret"], button[aria-label*="もっと"]'
  );
  if (!moreBtn) return;

  const btn = document.createElement('button');
  btn.className = 'jpfurigana-btn';
  btn.textContent = BUTTON_LABEL;
  btn.title = '为汉字标注假名读音';

  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    e.preventDefault();

    if (btn.classList.contains(ACTIVE_CLASS)) {
      // 切换关闭
      clearFurigana(tweetElement);
      btn.classList.remove(ACTIVE_CLASS);
      return;
    }

    const text = getTweetText(tweetElement);
    if (!text || !isJapaneseText(text)) return;

    btn.disabled = true;

    // 发送分析请求（通过 postMessage 到 inject.js）
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    try {
      const result = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('分析超时')), 15000);

        const handler = (event) => {
          if (event.data?.type === 'JP_ANALYSIS_RESULT' && event.data?.requestId === requestId) {
            window.removeEventListener('message', handler);
            clearTimeout(timeout);
            resolve(event.data.words);
          }
        };
        window.addEventListener('message', handler);

        // 发送分析请求
        window.postMessage({
          type: 'JP_ANALYZE_TEXT',
          requestId,
          text
        }, window.location.origin);
      });

      if (result && result.length > 0) {
        applyFurigana(tweetElement, result);
        btn.classList.add(ACTIVE_CLASS);
      }
    } catch (err) {
      console.error('[JPFurigana] Analysis error:', err);
    } finally {
      btn.disabled = false;
    }
  });

  // 插入到「更多」按钮之前（同一行，靠右）
  moreBtn.parentElement.insertBefore(btn, moreBtn);
}

// ---- MutationObserver 监听新推文 ----
function observeTweets() {
  let pendingNodes = [];
  let tickScheduled = false;

  const processPending = () => {
    tickScheduled = false;
    const nodes = pendingNodes;
    pendingNodes = [];

    for (const node of nodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;

      // 当前节点本身是推文
      if (node.matches?.('[data-testid="tweet"]')) {
        addButtonToTweet(node);
      }

      // 查找子推文
      const tweets = node.querySelectorAll?.('[data-testid="tweet"]');
      if (tweets && tweets.length > 0) {
        tweets.forEach(addButtonToTweet);
      }
    }
  };

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        pendingNodes.push(node);
      }
    }

    // 用 requestAnimationFrame 批量处理，避免频繁触发
    if (!tickScheduled) {
      tickScheduled = true;
      requestAnimationFrame(processPending);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
}

// ---- 扫描已有推文 ----
function scanExistingTweets() {
  document.querySelectorAll('[data-testid="tweet"]').forEach(addButtonToTweet);
}

// ---- 带重试的延迟扫描（X.com 是 React SPA，推文渲染晚于 DOM ready） ----
function scanWithRetry() {
  const delays = [500, 1500, 3000]; // ms
  delays.forEach(delay => {
    setTimeout(() => {
      scanExistingTweets();
    }, delay);
  });
}

// ---- 初始化 ----
function init() {
  injectAnalyzer();

  // MutationObserver 立即启动，捕获动态推文
  observeTweets();

  // 延迟扫描已渲染的推文（等 React 渲染完成）
  if (document.body) {
    scanWithRetry();
  } else {
    document.addEventListener('DOMContentLoaded', () => {
      scanWithRetry();
    });
  }
}

init();
