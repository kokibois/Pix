// Cloudflare Workers Web Proxy
// rammerhead/reflect4風のプロキシサービス

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // プロキシのメインページ
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(getIndexHTML(), {
        headers: { 'Content-Type': 'text/html; charset=UTF-8' }
      });
    }
    
    // プロキシリクエストの処理
    if (url.pathname.startsWith('/proxy/')) {
      return handleProxyRequest(request, url);
    }
    
    // 404エラー
    return new Response('Not Found', { status: 404 });
  }
};

async function handleProxyRequest(request, url) {
  try {
    // プロキシパスから実際のURLを取得
    const proxyPath = url.pathname.replace('/proxy/', '');
    const targetUrl = decodeURIComponent(proxyPath);
    
    // URLの妥当性チェック
    if (!isValidUrl(targetUrl)) {
      return new Response('Invalid URL', { status: 400 });
    }
    
    const parsedTargetUrl = new URL(targetUrl);
    
    // リクエストヘッダーを準備
    const headers = new Headers();
    
    // 必要なヘッダーをコピー
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
    
    // Originヘッダーを設定
    headers.set('Origin', `${parsedTargetUrl.protocol}//${parsedTargetUrl.host}`);
    headers.set('Referer', targetUrl);
    
    // プロキシリクエストを送信
    const proxyRequest = new Request(targetUrl, {
      method: request.method,
      headers: headers,
      body: request.method !== 'GET' && request.method !== 'HEAD' ? request.body : undefined
    });
    
    const response = await fetch(proxyRequest);
    const responseBody = await response.arrayBuffer();
    
    // レスポンスヘッダーを処理
    const responseHeaders = new Headers();
    
    // 安全なヘッダーのみコピー
    const safeHeaders = [
      'content-type',
      'content-length',
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
    
    // CORSヘッダーを追加
    responseHeaders.set('Access-Control-Allow-Origin', '*');
    responseHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    responseHeaders.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    
    // HTMLコンテンツの場合、URLを書き換え
    const contentType = response.headers.get('content-type') || '';
    let finalBody = responseBody;
    
    if (contentType.includes('text/html')) {
      const htmlContent = new TextDecoder().decode(responseBody);
      const modifiedHtml = rewriteHtmlUrls(htmlContent, parsedTargetUrl, url.origin);
      finalBody = new TextEncoder().encode(modifiedHtml);
      responseHeaders.set('Content-Length', finalBody.byteLength.toString());
    }
    
    return new Response(finalBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    });
    
  } catch (error) {
    console.error('Proxy error:', error);
    return new Response(`Proxy Error: ${error.message}`, { 
      status: 500,
      headers: { 'Content-Type': 'text/plain' }
    });
  }
}

function rewriteHtmlUrls(html, targetUrl, proxyOrigin) {
  const baseUrl = `${targetUrl.protocol}//${targetUrl.host}`;
  
  // 相対URLと絶対URLを書き換え
  html = html.replace(
    /(href|src|action)=["']([^"']+)["']/gi,
    (match, attr, url) => {
      try {
        let newUrl;
        if (url.startsWith('//')) {
          newUrl = `${targetUrl.protocol}${url}`;
        } else if (url.startsWith('/')) {
          newUrl = `${baseUrl}${url}`;
        } else if (url.startsWith('http')) {
          newUrl = url;
        } else {
          // 相対URL
          newUrl = new URL(url, targetUrl.href).href;
        }
        return `${attr}="${proxyOrigin}/proxy/${encodeURIComponent(newUrl)}"`;
      } catch {
        return match;
      }
    }
  );
  
  // Base tagを追加
  const baseTag = `<base href="${proxyOrigin}/proxy/${encodeURIComponent(baseUrl)}/">`;
  html = html.replace(/<head>/i, `<head>${baseTag}`);
  
  // プロキシスクリプトを追加
  const proxyScript = `
    <script>
    // URL書き換えスクリプト
    (function() {
      const proxyOrigin = '${proxyOrigin}';
      const originalFetch = window.fetch;
      
      window.fetch = function(input, init) {
        if (typeof input === 'string' && !input.startsWith('data:')) {
          let url = input;
          if (!url.startsWith('http')) {
            url = new URL(url, location.href).href;
          }
          url = url.replace(proxyOrigin + '/proxy/', '');
          url = decodeURIComponent(url);
          input = proxyOrigin + '/proxy/' + encodeURIComponent(url);
        }
        return originalFetch.call(this, input, init);
      };
      
      // XMLHttpRequestも書き換え
      const originalXHROpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(method, url, ...args) {
        if (typeof url === 'string' && !url.startsWith('data:')) {
          if (!url.startsWith('http')) {
            url = new URL(url, location.href).href;
          }
          url = url.replace(proxyOrigin + '/proxy/', '');
          url = decodeURIComponent(url);
          url = proxyOrigin + '/proxy/' + encodeURIComponent(url);
        }
        return originalXHROpen.call(this, method, url, ...args);
      };
    })();
    </script>
  `;
  
  html = html.replace(/<\/head>/i, `${proxyScript}</head>`);
  
  return html;
}

function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function getIndexHTML() {
  return `
<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Web Proxy Service</title>
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
        }
        
        .container {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 40px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
            max-width: 500px;
            width: 90%;
        }
        
        h1 {
            text-align: center;
            margin-bottom: 10px;
            color: #4a5568;
            font-size: 2.5em;
            font-weight: 700;
        }
        
        .subtitle {
            text-align: center;
            margin-bottom: 30px;
            color: #718096;
            font-size: 1.1em;
        }
        
        .form-group {
            margin-bottom: 25px;
        }
        
        label {
            display: block;
            margin-bottom: 8px;
            color: #4a5568;
            font-weight: 600;
        }
        
        input[type="url"] {
            width: 100%;
            padding: 15px;
            border: 2px solid #e2e8f0;
            border-radius: 12px;
            font-size: 16px;
            transition: all 0.3s ease;
            background: rgba(255, 255, 255, 0.8);
        }
        
        input[type="url"]:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
            transform: translateY(-2px);
        }
        
        button {
            width: 100%;
            padding: 15px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 12px;
            font-size: 18px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            text-transform: uppercase;
            letter-spacing: 1px;
        }
        
        button:hover {
            transform: translateY(-3px);
            box-shadow: 0 10px 25px rgba(102, 126, 234, 0.3);
        }
        
        button:active {
            transform: translateY(-1px);
        }
        
        .features {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 1px solid #e2e8f0;
        }
        
        .features h3 {
            color: #4a5568;
            margin-bottom: 15px;
            text-align: center;
        }
        
        .features ul {
            list-style: none;
            color: #718096;
        }
        
        .features li {
            margin-bottom: 8px;
            padding-left: 20px;
            position: relative;
        }
        
        .features li:before {
            content: "✓";
            position: absolute;
            left: 0;
            color: #48bb78;
            font-weight: bold;
        }
        
        @media (max-width: 480px) {
            .container {
                padding: 25px;
                margin: 20px;
            }
            
            h1 {
                font-size: 2em;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🌐 Web Proxy</h1>
        <p class="subtitle">安全で高速なウェブプロキシサービス</p>
        
        <form id="proxyForm">
            <div class="form-group">
                <label for="url">アクセスしたいURL:</label>
                <input 
                    type="url" 
                    id="url" 
                    name="url" 
                    placeholder="https://example.com" 
                    required
                    autocomplete="url"
                >
            </div>
            <button type="submit">アクセス</button>
        </form>
        
        <div class="features">
            <h3>主な機能</h3>
            <ul>
                <li>高速プロキシ接続</li>
                <li>SSL/HTTPS対応</li>
                <li>JavaScript完全対応</li>
                <li>リアルタイムURL書き換え</li>
                <li>CORS制限回避</li>
            </ul>
        </div>
    </div>

    <script>
        document.getElementById('proxyForm').addEventListener('submit', function(e) {
            e.preventDefault();
            
            const urlInput = document.getElementById('url');
            const url = urlInput.value.trim();
            
            if (!url) {
                alert('URLを入力してください');
                return;
            }
            
            // URLの正規化
            let targetUrl = url;
            if (!targetUrl.match(/^https?:\/\//)) {
                targetUrl = 'https://' + targetUrl;
            }
            
            // プロキシURLに移動
            const proxyUrl = '/proxy/' + encodeURIComponent(targetUrl);
            window.location.href = proxyUrl;
        });
        
        // エンターキーでフォーム送信
        document.getElementById('url').addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                document.getElementById('proxyForm').dispatchEvent(new Event('submit'));
            }
        });
        
        // URLの自動補完
        document.getElementById('url').addEventListener('input', function(e) {
            let value = e.target.value;
            if (value && !value.match(/^https?:\/\//) && value.includes('.')) {
                // ヒントとしてプロトコルを表示
                e.target.style.background = 'linear-gradient(90deg, transparent 0%, rgba(102, 126, 234, 0.1) 100%)';
            } else {
                e.target.style.background = 'rgba(255, 255, 255, 0.8)';
            }
        });
    </script>
</body>
</html>`;
}
