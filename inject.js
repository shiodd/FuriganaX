

(function () {
  // 如果已经初始化则跳过
  if (window.__jpfuriganaInjected) return;
  window.__jpfuriganaInjected = true;

  // 获取当前 extension ID（从注入的脚本元素 src 解析）
  const scriptEl = document.currentScript || document.querySelector('script[data-jpfurigana]');
  const scriptSrc = scriptEl ? scriptEl.src : '';
  const extMatch = scriptSrc.match(/chrome-extension:\/\/([^/]+)\//);
  const EXT_ID = extMatch ? extMatch[1] : '';
  if (!EXT_ID) {
    console.warn('[JPFurigana] 无法获取 Extension ID');
    return;
  }

  const KUROMOJI_URL = `chrome-extension://${EXT_ID}/kuromoji.js`;
  const DICT_PATH = `chrome-extension://${EXT_ID}/dict/`;

  let tokenizer = null;
  let isReady = false;

  // ---- 加载 kuromoji ----
  function loadKuromoji() {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = KUROMOJI_URL;
      script.onload = () => {
        script.remove();
        resolve();
      };
      script.onerror = () => {
        script.remove();
        reject(new Error('加载 kuromoji.js 失败'));
      };
      document.head.appendChild(script);
    });
  }

  // ---- 初始化 kuromoji 分词器 ----
  async function initTokenizer() {
    try {
      // 先等 kuromoji 库加载
      await loadKuromoji();

      // 现在 window.kuromoji 可用
      return new Promise((resolve, reject) => {
        window.kuromoji.builder({ dicPath: DICT_PATH }).build((err, builtTokenizer) => {
          if (err) {
            reject(err);
            return;
          }
          tokenizer = builtTokenizer;
          isReady = true;
          console.log('[JPFurigana] Kuromoji 初始化完成');
          resolve();
        });
      });
    } catch (e) {
      console.error('[JPFurigana] 初始化失败:', e);
    }
  }

  // ---- 检查字符类型 ----
  function isKanji(ch) {
    return /[\u4e00-\u9faf\u3400-\u4dbf]/.test(ch);
  }

  // ---- 分析文本，生成标注数据 ----
  function analyzeText(text) {
    if (!tokenizer) return [];

    const tokens = tokenizer.tokenize(text);
    const result = [];
    let accumulated = '';

    function flushAccumulated() {
      if (accumulated) {
        result.push({ text: accumulated });
        accumulated = '';
      }
    }

    for (const token of tokens) {
      const surface = token.surface_form;
      const reading = token.reading; // 片假名读音
      const pos = token.pos; // 词性

      // 判断是否为汉字词（需要标注）
      const hasKanji = [...surface].some(isKanji);
      // 排除纯标点、数字、英文字母等
      const isWord = hasKanji;

      if (isWord && reading && reading !== surface && reading !== '*') {
        flushAccumulated();

        // 将片假名读音转为平假名
        const hiragana = reading.replace(/[\u30a1-\u30f6]/g, function (ch) {
          return String.fromCharCode(ch.charCodeAt(0) - 0x60);
        });

        result.push({ kanji: surface, kana: hiragana });
      } else {
        accumulated += surface;
      }
    }

    flushAccumulated();
    return result;
  }

  // ---- 监听来自 content.js 的消息 ----
  window.addEventListener('message', (event) => {
    if (event.data?.type !== 'JP_ANALYZE_TEXT') return;

    const { requestId, text } = event.data;

    if (!isReady) {
      window.postMessage({
        type: 'JP_ANALYSIS_RESULT',
        requestId,
        words: [],
        error: '分词器尚未就绪'
      }, window.location.origin);
      return;
    }

    const words = analyzeText(text);

    window.postMessage({
      type: 'JP_ANALYSIS_RESULT',
      requestId,
      words
    }, window.location.origin);
  });

  // ---- 启动初始化 ----
  initTokenizer().then(() => {
    // 通知 content.js 已就绪
    window.postMessage({
      type: 'JP_ANALYZER_READY',
      ready: true
    }, window.location.origin);
  });

})();
