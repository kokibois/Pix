// Cloudflare Workers Web Proxy Service
// src/index.js

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // CORSプリフライトリクエストの処理
    if (request.method === 'OPTIONS') {
      return handleCORS();
    }
    
    // URLパラメーターからのプロキシリクエスト処理
    if (url.searchParams.has('url')) {
      const targetUrl = url.searchParams.get('url');
      return handleProxyFromParam(request, targetUrl, env);
    }
    
    // プロキシのメインページ
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(getIndexHTML(), {
        headers: { 
          'Content-Type': 'text/html; charset=UTF-8',
          ...getCORSHeaders()
        }
      });
    }
    
    // プロキシリクエストの処理
    if (url.pathname.startsWith('/proxy/')) {
      return handleProxyRequest(request, url, env);
    }
    
    // 静的ファイルの処理
    if (url.pathname.startsWith('/static/')) {
      return handleStaticFiles(url.pathname);
    }
    
    // 404エラー
    return new Response('Not Found', { 
      status: 404,
      headers: getCORSHeaders()
    });
  }
};

async function handleProxyFromParam(request, targetUrl, env) {
  try {
    console.log('Proxy from param:', targetUrl);
    
    // URLの妥当性チェック
    if (!isValidUrl(targetUrl)) {
      console.log('Invalid URL from param:', targetUrl);
      return new Response(`Invalid URL: ${targetUrl}`, { 
        status: 400,
        headers: getCORSHeaders()
      });
    }
    
    const parsedTargetUrl = new URL(targetUrl);
    
    // ブロックリストチェック
    if (isBlocked(parsedTargetUrl.hostname)) {
      return new Response('Access denied', { 
        status: 403,
        headers: getCORSHeaders()
      });
    }
    
    // リクエストヘッダーを準備
    const headers = new Headers();
    
    // 許可されたヘッダーのみコピー
    const allowedHeaders = [
      'accept',
      'accept-language', 
      'cache-control',
      'content-type',
      'user-agent'
    ];
    
    for (const [key, value] of request.headers) {
      if (allowedHeaders.includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    }
    
    // 必要なヘッダーを設定
    headers.set('Origin', `${parsedTargetUrl.protocol}//${parsedTargetUrl.host}`);
    headers.set('Referer', targetUrl);
    headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    
    // プロキシリクエストを送信
    const proxyRequest = new Request(targetUrl, {
      method: 'GET',
      headers: headers,
      redirect: 'follow'
    });
    
    const response = await fetch(proxyRequest);
    
    // レスポンスヘッダーを処理
    const responseHeaders = new Headers(getCORSHeaders());
    
    // 安全なヘッダーのみコピー
    const safeHeaders = [
      'content-type',
      'cache-control',
      'expires',
      'last-modified',
      'etag'
    ];
    
    for (const [key, value] of response.headers) {
      if (safeHeaders.includes(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    }
    
    // レスポンスボディを取得
    const responseBody = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || '';
    let finalBody = responseBody;
    
    // HTMLコンテンツの場合、URLを書き換え
    if (contentType.includes('text/html')) {
      try {
        const htmlContent = new TextDecoder('utf-8').decode(responseBody);
        // URLパラメーター形式用のHTML書き換え
        const modifiedHtml = rewriteHtmlUrlsForParam(htmlContent, parsedTargetUrl, new URL(request.url).origin);
        finalBody = new TextEncoder().encode(modifiedHtml);
        responseHeaders.set('Content-Length', finalBody.byteLength.toString());
      } catch (e) {
        console.log('HTML processing error:', e);
        finalBody = responseBody;
      }
    }
    
    return new Response(finalBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });
    
  } catch (error) {
    console.error('Proxy from param error:', error);
    return new Response(`Proxy Error: ${error.message}`, { 
      status: 500,
      headers: {
        'Content-Type': 'text/plain',
        ...getCORSHeaders()
      }
    });
  }
}

function rewriteHtmlUrlsForParam(html, targetUrl, proxyOrigin) {
  const baseUrl = `${targetUrl.protocol}//${targetUrl.host}`;
  
  // 相対URLと絶対URLを書き換え（URLパラメーター形式用）
  html = html.replace(
    /(href|src|action|data-src|data-href)=["']([^"']+)["']/gi,
    (match, attr, url) => {
      try {
        if (url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('#')) {
          return match;
        }
        
        let newUrl;
        if (url.startsWith('//')) {
          newUrl = `${targetUrl.protocol}${url}`;
        } else if (url.startsWith('/')) {
          newUrl = `${baseUrl}${url}`;
        } else if (url.startsWith('http')) {
          newUrl = url;
        } else {
          newUrl = new URL(url, targetUrl.href).href;
        }
        
        return `${attr}="${proxyOrigin}/?url=${encodeURIComponent(newUrl)}"`;
      } catch {
        return match;
      }
    }
  );
  
  // Meta refresh書き換え
  html = html.replace(
    /<meta\s+http-equiv=["']refresh["']\s+content=["'](\d+);url=([^"']+)["']/gi,
    (match, time, url) => {
      try {
        let newUrl;
        if (url.startsWith('//')) {
          newUrl = `${targetUrl.protocol}${url}`;
        } else if (url.startsWith('/')) {
          newUrl = `${baseUrl}${url}`;
        } else if (url.startsWith('http')) {
          newUrl = url;
        } else {
          newUrl = new URL(url, targetUrl.href).href;
        }
        return `<meta http-equiv="refresh" content="${time};url=${proxyOrigin}/?url=${encodeURIComponent(newUrl)}"`;
      } catch {
        return match;
      }
    }
  );
  
  // プロキシスクリプトを追加
  const proxyScript = getProxyScriptForParam(proxyOrigin, baseUrl);
  html = html.replace(/<\/head>/i, `${proxyScript}</head>`);
  
  return html;
}

function getProxyScriptForParam(proxyOrigin, baseUrl) {
  return `
    <script>
    // Proxy JavaScript injection (URL param version)
    (function() {
      const PROXY_ORIGIN = '${proxyOrigin}';
      const BASE_URL = '${baseUrl}';
      
      // Helper function to encode URL for param method
      function encodeProxyUrl(url) {
        try {
          let fullUrl;
          if (url.startsWith('//')) {
            fullUrl = window.location.protocol + url;
          } else if (url.startsWith('/')) {
            fullUrl = BASE_URL + url;
          } else if (url.startsWith('http')) {
            fullUrl = url;
          } else {
            fullUrl = new URL(url, window.location.href).href;
          }
          return PROXY_ORIGIN + '/?url=' + encodeURIComponent(fullUrl);
        } catch {
          return url;
        }
      }
      
      // Override fetch
      const originalFetch = window.fetch;
      window.fetch = function(input, init) {
        if (typeof input === 'string' && !input.startsWith('data:')) {
          input = encodeProxyUrl(input);
        }
        return originalFetch.call(this, input, init);
      };
      
      // Override XMLHttpRequest
      const originalXHROpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url, ...args) {
        if (typeof url === 'string' && !url.startsWith('data:')) {
          url = encodeProxyUrl(url);
        }
        return originalXHROpen.call(this, method, url, ...args);
      };
      
      // Override window.open
      const originalOpen = window.open;
      window.open = function(url, ...args) {
        if (url && typeof url === 'string' && !url.startsWith('data:')) {
          url = encodeProxyUrl(url);
        }
        return originalOpen.call(this, url, ...args);
      };
      
      console.log('Proxy JavaScript loaded successfully (param version)');
    })();
    </script>
  `;
}
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-Proxy-Target',
    'Access-Control-Max-Age': '86400'
  };
}

function handleCORS() {
  return new Response(null, {
    status: 200,
    headers: getCORSHeaders()
  });
}

async function handleProxyRequest(request, url, env) {
  try {
    // レート制限チェック（オプション）
    if (env.RATE_LIMIT && await checkRateLimit(request, env)) {
      return new Response('Rate limit exceeded', { 
        status: 429,
        headers: getCORSHeaders()
      });
    }
    
    // プロキシパスから実際のURLを取得
    const proxyPath = url.pathname.replace('/proxy/', '');
    let targetUrl;
    
    // URLデコード処理を改善
    try {
      // まずBase64デコードを試す
      if (proxyPath.match(/^[A-Za-z0-9+/]+=*$/)) {
        targetUrl = atob(proxyPath);
      } else {
        // URLデコードを試す
        targetUrl = decodeURIComponent(proxyPath);
      }
    } catch (e) {
      console.log('URL decode error:', e);
      // フォールバック: そのまま使用
      targetUrl = proxyPath;
    }
    
    // URLの妥当性チェック
    if (!isValidUrl(targetUrl)) {
      console.log('Invalid URL:', targetUrl);
      return new Response(`Invalid URL: ${targetUrl}`, { 
        status: 400,
        headers: getCORSHeaders()
      });
    }
    
    console.log('Proxying to:', targetUrl);
    
    const parsedTargetUrl = new URL(targetUrl);
    
    // ブロックリストチェック
    if (isBlocked(parsedTargetUrl.hostname)) {
      return new Response('Access denied', { 
        status: 403,
        headers: getCORSHeaders()
      });
    }
    
    // リクエストヘッダーを準備
    const headers = new Headers();
    
    // 許可されたヘッダーのみコピー
    const allowedHeaders = [
      'accept',
      'accept-language', 
      'cache-control',
      'content-type',
      'user-agent'
    ];
    
    for (const [key, value] of request.headers) {
      if (allowedHeaders.includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    }
    
    // 必要なヘッダーを設定
    headers.set('Origin', `${parsedTargetUrl.protocol}//${parsedTargetUrl.host}`);
    headers.set('Referer', targetUrl);
    headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    
    // リクエストボディの処理
    let body = null;
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      body = await request.arrayBuffer();
    }
    
    // プロキシリクエストを送信
    const proxyRequest = new Request(targetUrl, {
      method: request.method,
      headers: headers,
      body: body,
      redirect: 'follow'
    });
    
    const response = await fetch(proxyRequest);
    
    // レスポンスヘッダーを処理
    const responseHeaders = new Headers(getCORSHeaders());
    
    // 安全なヘッダーのみコピー
    const safeHeaders = [
      'content-type',
      'cache-control',
      'expires',
      'last-modified',
      'etag'
    ];
    
    for (const [key, value] of response.headers) {
      if (safeHeaders.includes(key.toLowerCase())) {
        responseHeaders.set(key, value);
      }
    }
    
    // レスポンスボディを取得
    const responseBody = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || '';
    let finalBody = responseBody;
    
    // HTMLコンテンツの場合、URLを書き換え
    if (contentType.includes('text/html')) {
      try {
        const htmlContent = new TextDecoder('utf-8').decode(responseBody);
        const modifiedHtml = rewriteHtmlUrls(htmlContent, parsedTargetUrl, url.origin);
        finalBody = new TextEncoder().encode(modifiedHtml);
        responseHeaders.set('Content-Length', finalBody.byteLength.toString());
      } catch (e) {
        console.log('HTML processing error:', e);
        // HTMLエラーの場合はオリジナルを返す
        finalBody = responseBody;
      }
    }
    
    // CSSファイルのURL書き換え
    else if (contentType.includes('text/css')) {
      try {
        const cssContent = new TextDecoder('utf-8').decode(responseBody);
        const modifiedCss = rewriteCssUrls(cssContent, parsedTargetUrl, url.origin);
        finalBody = new TextEncoder().encode(modifiedCss);
        responseHeaders.set('Content-Length', finalBody.byteLength.toString());
      } catch (e) {
        console.log('CSS processing error:', e);
        finalBody = responseBody;
      }
    }
    
    return new Response(finalBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });
    
  } catch (error) {
    console.error('Proxy error:', error);
    return new Response(`Proxy Error: ${error.message}\nTarget URL might be invalid or unreachable.`, { 
      status: 500,
      headers: {
        'Content-Type': 'text/plain',
        ...getCORSHeaders()
      }
    });
  }
}

function rewriteHtmlUrls(html, targetUrl, proxyOrigin) {
  const baseUrl = `${targetUrl.protocol}//${targetUrl.host}`;
  
  // 相対URLと絶対URLを書き換え
  html = html.replace(
    /(href|src|action|data-src|data-href)=["']([^"']+)["']/gi,
    (match, attr, url) => {
      try {
        if (url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('#')) {
          return match;
        }
        
        let newUrl;
        if (url.startsWith('//')) {
          newUrl = `${targetUrl.protocol}${url}`;
        } else if (url.startsWith('/')) {
          newUrl = `${baseUrl}${url}`;
        } else if (url.startsWith('http')) {
          newUrl = url;
        } else {
          newUrl = new URL(url, targetUrl.href).href;
        }
        
        const encodedUrl = encodeURIComponent(newUrl);
        return `${attr}="${proxyOrigin}/proxy/${encodedUrl}"`;
      } catch {
        return match;
      }
    }
  );
  
  // Meta refresh書き換え
  html = html.replace(
    /<meta\s+http-equiv=["']refresh["']\s+content=["'](\d+);url=([^"']+)["']/gi,
    (match, time, url) => {
      try {
        let newUrl;
        if (url.startsWith('//')) {
          newUrl = `${targetUrl.protocol}${url}`;
        } else if (url.startsWith('/')) {
          newUrl = `${baseUrl}${url}`;
        } else if (url.startsWith('http')) {
          newUrl = url;
        } else {
          newUrl = new URL(url, targetUrl.href).href;
        }
        const encodedUrl = encodeURIComponent(newUrl);
        return `<meta http-equiv="refresh" content="${time};url=${proxyOrigin}/proxy/${encodedUrl}"`;
      } catch {
        return match;
      }
    }
  );
  
  // プロキシスクリプトを追加
  const proxyScript = getProxyScript(proxyOrigin, baseUrl);
  html = html.replace(/<\/head>/i, `${proxyScript}</head>`);
  
  return html;
}

function rewriteCssUrls(css, targetUrl, proxyOrigin) {
  const baseUrl = `${targetUrl.protocol}//${targetUrl.host}`;
  
  return css.replace(
    /url\(["']?([^"')]+)["']?\)/gi,
    (match, url) => {
      try {
        if (url.startsWith('data:') || url.startsWith('#')) {
          return match;
        }
        
        let newUrl;
        if (url.startsWith('//')) {
          newUrl = `${targetUrl.protocol}${url}`;
        } else if (url.startsWith('/')) {
          newUrl = `${baseUrl}${url}`;
        } else if (url.startsWith('http')) {
          newUrl = url;
        } else {
          newUrl = new URL(url, targetUrl.href).href;
        }
        
        const encodedUrl = encodeURIComponent(newUrl);
        return `url("${proxyOrigin}/proxy/${encodedUrl}")`;
      } catch {
        return match;
      }
    }
  );
}

function getProxyScript(proxyOrigin, baseUrl) {
  return `
    <script>
    // Proxy JavaScript injection
    (function() {
      const PROXY_ORIGIN = '${proxyOrigin}';
      const BASE_URL = '${baseUrl}';
      
      // Helper function to encode URL
      function encodeProxyUrl(url) {
        try {
          let fullUrl;
          if (url.startsWith('//')) {
            fullUrl = window.location.protocol + url;
          } else if (url.startsWith('/')) {
            fullUrl = BASE_URL + url;
          } else if (url.startsWith('http')) {
            fullUrl = url;
          } else {
            fullUrl = new URL(url, window.location.href).href;
          }
          return PROXY_ORIGIN + '/proxy/' + encodeURIComponent(fullUrl);
        } catch {
          return url;
        }
      }
      
      // Override fetch
      const originalFetch = window.fetch;
      window.fetch = function(input, init) {
        if (typeof input === 'string' && !input.startsWith('data:')) {
          input = encodeProxyUrl(input);
        }
        return originalFetch.call(this, input, init);
      };
      
      // Override XMLHttpRequest
      const originalXHROpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url, ...args) {
        if (typeof url === 'string' && !url.startsWith('data:')) {
          url = encodeProxyUrl(url);
        }
        return originalXHROpen.call(this, method, url, ...args);
      };
      
      // Override window.open
      const originalOpen = window.open;
      window.open = function(url, ...args) {
        if (url && typeof url === 'string' && !url.startsWith('data:')) {
          url = encodeProxyUrl(url);
        }
        return originalOpen.call(this, url, ...args);
      };
      
      // Override location.href assignments
      let originalHref = window.location.href;
      Object.defineProperty(window.location, 'href', {
        get: function() { return originalHref; },
        set: function(url) {
          if (typeof url === 'string' && !url.startsWith('data:')) {
            window.location.assign(encodeProxyUrl(url));
          }
        }
      });
      
      console.log('Proxy JavaScript loaded successfully');
    })();
    </script>
  `;
}

function isValidUrl(string) {
  try {
    const url = new URL(string);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function isBlocked(hostname) {
  const blockedDomains = [
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '10.',
    '192.168.',
    '172.'
  ];
  
  return blockedDomains.some(blocked => hostname.startsWith(blocked));
}

async function checkRateLimit(request, env) {
  // 簡単なレート制限実装（実際の運用では外部ストレージを使用）
  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
  // ここでRedisやKVを使用してレート制限を実装
  return false; // 今回は無効
}

function handleStaticFiles(pathname) {
  // 静的ファイル配信（必要に応じて）
  return new Response('Static file not found', { status: 404 });
}

function getIndexHTML() {
  return `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>🌐 Web Proxy Service</title>
    <meta name="description" content="高速で安全なWebプロキシサービス">
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #333;
            overflow-x: hidden;
        }
        
        .background-animation {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            z-index: -1;
            opacity: 0.1;
        }
        
        .particle {
            position: absolute;
            background: white;
            border-radius: 50%;
            animation: float 6s ease-in-out infinite;
        }
        
        @keyframes float {
            0%, 100% { transform: translateY(0px) rotate(0deg); }
            33% { transform: translateY(-20px) rotate(120deg); }
            66% { transform: translateY(10px) rotate(240deg); }
        }
        
        .container {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(15px);
            border-radius: 25px;
            padding: 50px;
            box-shadow: 0 25px 50px rgba(0, 0, 0, 0.15);
            max-width: 600px;
            width: 90%;
            position: relative;
            z-index: 1;
            border: 1px solid rgba(255, 255, 255, 0.2);
        }
        
        .logo {
            text-align: center;
            margin-bottom: 15px;
        }
        
        .logo-emoji {
            font-size: 4em;
            margin-bottom: 10px;
            display: block;
            animation: pulse 2s ease-in-out infinite;
        }
        
        @keyframes pulse {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.05); }
        }
        
        h1 {
            text-align: center;
            margin-bottom: 10px;
            color: #4a5568;
            font-size: 2.8em;
            font-weight: 800;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        
        .subtitle {
            text-align: center;
            margin-bottom: 40px;
            color: #718096;
            font-size: 1.2em;
            font-weight: 500;
        }
        
        .form-group {
            margin-bottom: 30px;
            position: relative;
        }
        
        .input-container {
            position: relative;
            display: flex;
            align-items: center;
        }
        
        input[type="url"] {
            width: 100%;
            padding: 20px 60px 20px 20px;
            border: 3px solid #e2e8f0;
            border-radius: 15px;
            font-size: 18px;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            background: rgba(255, 255, 255, 0.9);
            font-weight: 500;
        }
        
        input[type="url"]:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 4px rgba(102, 126, 234, 0.15);
            transform: translateY(-2px);
            background: rgba(255, 255, 255, 1);
        }
        
        .url-icon {
            position: absolute;
            right: 15px;
            font-size: 24px;
            color: #a0aec0;
            pointer-events: none;
        }
        
        button {
            width: 100%;
            padding: 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 15px;
            font-size: 20px;
            font-weight: 700;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            text-transform: uppercase;
            letter-spacing: 1.5px;
            position: relative;
            overflow: hidden;
        }
        
        button::before {
            content: '';
            position: absolute;
            top: 0;
            left: -100%;
            width: 100%;
            height: 100%;
            background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.2), transparent);
            transition: left 0.5s;
        }
        
        button:hover::before {
            left: 100%;
        }
        
        button:hover {
            transform: translateY(-3px);
            box-shadow: 0 15px 35px rgba(102, 126, 234, 0.4);
        }
        
        button:active {
            transform: translateY(-1px);
        }
        
        .features {
            margin-top: 40px;
            padding-top: 30px;
            border-top: 2px solid #e2e8f0;
        }
        
        .features h3 {
            color: #4a5568;
            margin-bottom: 20px;
            text-align: center;
            font-size: 1.5em;
            font-weight: 700;
        }
        
        .features-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 20px;
        }
        
        .feature-item {
            display: flex;
            align-items: center;
            padding: 15px;
            background: rgba(102, 126, 234, 0.05);
            border-radius: 12px;
            transition: all 0.3s ease;
        }
        
        .feature-item:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(102, 126, 234, 0.15);
        }
        
        .feature-icon {
            font-size: 1.5em;
            margin-right: 12px;
            color: #667eea;
        }
        
        .feature-text {
            color: #4a5568;
            font-weight: 500;
        }
        
        .status-indicator {
            position: fixed;
            top: 20px;
            right: 20px;
            background: rgba(72, 187, 120, 0.9);
            color: white;
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 14px;
            font-weight: 600;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.2);
        }
        
        @media (max-width: 768px) {
            .container {
                padding: 30px 25px;
                margin: 20px;
            }
            
            h1 {
                font-size: 2.2em;
            }
            
            .features-grid {
                grid-template-columns: 1fr;
            }
            
            input[type="url"] {
                padding: 18px 50px 18px 18px;
                font-size: 16px;
            }
            
            button {
                padding: 18px;
                font-size: 18px;
            }
        }
    </style>
</head>
<body>
    <div class="background-animation" id="particles"></div>
    
    <div class="status-indicator">
        🟢 オンライン
    </div>
    
    <div class="container">
        <div class="logo">
            <span class="logo-emoji">🌐</span>
        </div>
        <h1>Web Proxy</h1>
        <p class="subtitle">安全で高速なウェブプロキシサービス</p>
        
        <form id="proxyForm">
            <div class="form-group">
                <div class="input-container">
                    <input 
                        type="url" 
                        id="url" 
                        name="url" 
                        placeholder="https://example.com" 
                        required
                        autocomplete="url"
                    >
                    <span class="url-icon">🔗</span>
                </div>
            </div>
            <button type="submit">🚀 アクセス</button>
        </form>
        
        <div class="features">
            <h3>✨ 主な機能</h3>
            <div class="features-grid">
                <div class="feature-item">
                    <span class="feature-icon">⚡</span>
                    <span class="feature-text">高速プロキシ接続</span>
                </div>
                <div class="feature-item">
                    <span class="feature-icon">🔒</span>
                    <span class="feature-text">SSL/HTTPS完全対応</span>
                </div>
                <div class="feature-item">
                    <span class="feature-icon">📱</span>
                    <span class="feature-text">モバイル最適化</span>
                </div>
                <div class="feature-item">
                    <span class="feature-icon">🎯</span>
                    <span class="feature-text">JavaScript完全対応</span>
                </div>
                <div class="feature-item">
                    <span class="feature-icon">🔄</span>
                    <span class="feature-text">リアルタイムURL書き換え</span>
                </div>
                <div class="feature-item">
                    <span class="feature-icon">🛡️</span>
                    <span class="feature-text">CORS制限回避</span>
                </div>
            </div>
        </div>
    </div>

    <script>
        // パーティクルアニメーション
        function createParticles() {
            const container = document.getElementById('particles');
            const particleCount = 20;
            
            for (let i = 0; i < particleCount; i++) {
                const particle = document.createElement('div');
                particle.className = 'particle';
                
                const size = Math.random() * 4 + 1;
                particle.style.width = size + 'px';
                particle.style.height = size + 'px';
                particle.style.left = Math.random() * 100 + '%';
                particle.style.top = Math.random() * 100 + '%';
                particle.style.animationDelay = Math.random() * 6 + 's';
                particle.style.animationDuration = (Math.random() * 3 + 3) + 's';
                
                container.appendChild(particle);
            }
        }
        
        // フォーム送信処理
        document.getElementById('proxyForm').addEventListener('submit', function(e) {
            e.preventDefault();
            
            const urlInput = document.getElementById('url');
            const url = urlInput.value.trim();
            
            if (!url) {
                showNotification('URLを入力してください', 'error');
                return;
            }
            
            // URLの正規化
            let targetUrl = url;
            if (!targetUrl.match(/^https?:\/\//)) {
                targetUrl = 'https://' + targetUrl;
            }
            
            // URL検証
            try {
                new URL(targetUrl);
            } catch {
                showNotification('有効なURLを入力してください', 'error');
                return;
            }
            
            // ローディング状態
            const button = document.querySelector('button');
            const originalText = button.textContent;
            button.textContent = '🔄 接続中...';
            button.disabled = true;
            
            // プロキシURLに移動
            const proxyUrl = '/proxy/' + encodeURIComponent(targetUrl);
            console.log('Navigating to:', proxyUrl);
            window.location.href = proxyUrl;
        });
        
        // 通知表示
        function showNotification(message, type = 'info') {
            const notification = document.createElement('div');
            notification.textContent = message;
            notification.style.cssText = 
                'position: fixed;' +
                'top: 80px;' +
                'right: 20px;' +
                'background: ' + (type === 'error' ? '#f56565' : '#48bb78') + ';' +
                'color: white;' +
                'padding: 15px 20px;' +
                'border-radius: 10px;' +
                'font-weight: 600;' +
                'z-index: 1000;' +
                'animation: slideIn 0.3s ease;';
            
            document.body.appendChild(notification);
            
            setTimeout(() => {
                notification.style.animation = 'slideOut 0.3s ease forwards';
                setTimeout(() => notification.remove(), 300);
            }, 3000);
        }
        
        // URL入力時のリアルタイム検証
        document.getElementById('url').addEventListener('input', function(e) {
            let value = e.target.value;
            const urlIcon = document.querySelector('.url-icon');
            
            if (value && !value.match(/^https?:\/\//) && value.includes('.')) {
                e.target.style.background = 'linear-gradient(90deg, rgba(255,255,255,0.9) 0%, rgba(102, 126, 234, 0.1) 100%)';
                urlIcon.textContent = '🔗';
            } else if (value && value.match(/^https?:\/\//)) {
                e.target.style.background = 'linear-gradient(90deg, rgba(255,255,255,0.9) 0%, rgba(72, 187, 120, 0.1) 100%)';
                urlIcon.textContent = '✅';
            } else {
                e.target.style.background = 'rgba(255, 255, 255, 0.9)';
                urlIcon.textContent = '🔗';
            }
        });
        
        // エンターキーでフォーム送信
        document.getElementById('url').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                document.getElementById('proxyForm').dispatchEvent(new Event('submit'));
            }
        });
        
        // 初期化
        document.addEventListener('DOMContentLoaded', function() {
            createParticles();
            
            // フォーカス時のアニメーション
            const urlInput = document.getElementById('url');
            urlInput.addEventListener('focus', function() {
                this.parentElement.style.transform = 'scale(1.02)';
            });
            
            urlInput.addEventListener('blur', function() {
                this.parentElement.style.transform = 'scale(1)';
            });
        });
        
        // CSS animations
        const style = document.createElement('style');
        style.textContent = 
            '@keyframes slideIn {' +
            '  from { transform: translateX(100%); opacity: 0; }' +
            '  to { transform: translateX(0); opacity: 1; }' +
            '}' +
            '@keyframes slideOut {' +
            '  from { transform: translateX(0); opacity: 1; }' +
            '  to { transform: translateX(100%); opacity: 0; }' +
            '}';
        document.head.appendChild(style);
    </script>
</body>
</html>`;
}
