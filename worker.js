import { connect } from 'cloudflare:sockets';

/**
 * Cloudflare Worker — CTV API Proxy + Frontend
 * 
 * Chức năng:
 * 1. Serve giao diện bán hàng tại /
 * 2. Proxy API tới server gốc (ẩn API key)
 * 3. Lọc chỉ sản phẩm Grok + ChatGPT
 * 
 * Environment Variables:
 * - API_KEY: DLR_xxxxx
 * - API_BASE: http://103.69.87.202:5000
 */

// Danh sách product_key chỉ Grok + ChatGPT
const ALLOWED_PRODUCTS = [
  'gptplus_1thang_KBH',
  'gptplus_1thang_BHF',
  'slot_gpt_team',
  'admingpt_bh',
  'admingpt_kbh',
  'cdkgpt_kbh',
  'supergrok_1thang_bhf',
  'supergrok_1nam_bhf',
];

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, status = 200, request) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(request),
    },
  });
}

function filterProducts(products) {
  const filtered = {};
  for (const [key, value] of Object.entries(products)) {
    if (ALLOWED_PRODUCTS.includes(key)) {
      filtered[key] = value;
    }
  }
  return filtered;
}

// ============================================
// TCP RAW HTTP — Bypass Cloudflare IP fetch restriction
// Cloudflare Workers chặn fetch() tới IP trực tiếp (error 1003)
// Dùng connect() TCP socket để gửi raw HTTP request
// ============================================


function parseApiBase(apiBase) {
  const u = new URL(apiBase);
  return { host: u.hostname, port: parseInt(u.port) || 80 };
}

async function rawHttpRequest(host, port, method, path, headers = {}, body = null) {
  const socket = connect({ hostname: host, port: port });
  const writer = socket.writable.getWriter();
  const encoder = new TextEncoder();

  // Build raw HTTP request
  let reqStr = `${method} ${path} HTTP/1.1\r\n`;
  reqStr += `Host: ${host}:${port}\r\n`;
  reqStr += `Connection: close\r\n`;
  
  for (const [k, v] of Object.entries(headers)) {
    reqStr += `${k}: ${v}\r\n`;
  }

  if (body) {
    const bodyBytes = encoder.encode(body);
    reqStr += `Content-Length: ${bodyBytes.length}\r\n`;
    reqStr += `\r\n`;
    await writer.write(encoder.encode(reqStr));
    await writer.write(bodyBytes);
  } else {
    reqStr += `\r\n`;
    await writer.write(encoder.encode(reqStr));
  }

  await writer.close();

  // Read response
  const reader = socket.readable.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  // Combine chunks
  const totalLen = chunks.reduce((s, c) => s + c.length, 0);
  const combined = new Uint8Array(totalLen);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }

  const fullResponse = new TextDecoder().decode(combined);

  // Parse HTTP response — split header and body
  const headerEndIdx = fullResponse.indexOf('\r\n\r\n');
  if (headerEndIdx === -1) {
    throw new Error('Invalid HTTP response');
  }

  const headerPart = fullResponse.substring(0, headerEndIdx);
  const bodyPart = fullResponse.substring(headerEndIdx + 4);

  // Parse status code
  const statusMatch = headerPart.match(/HTTP\/[\d.]+ (\d+)/);
  const status = statusMatch ? parseInt(statusMatch[1]) : 500;

  // Handle chunked transfer encoding
  let responseBody = bodyPart;
  if (headerPart.toLowerCase().includes('transfer-encoding: chunked')) {
    responseBody = parseChunked(bodyPart);
  }

  // Parse JSON
  try {
    return { status, data: JSON.parse(responseBody) };
  } catch {
    return { status, data: { success: false, error: `Server trả về (HTTP ${status}): ${responseBody.substring(0, 200)}` } };
  }
}

function parseChunked(body) {
  let result = '';
  let remaining = body;
  while (remaining.length > 0) {
    const lineEnd = remaining.indexOf('\r\n');
    if (lineEnd === -1) break;
    const chunkSize = parseInt(remaining.substring(0, lineEnd), 16);
    if (isNaN(chunkSize) || chunkSize === 0) break;
    result += remaining.substring(lineEnd + 2, lineEnd + 2 + chunkSize);
    remaining = remaining.substring(lineEnd + 2 + chunkSize + 2);
  }
  return result;
}

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const { host: apiHost, port: apiPort } = parseApiBase(env.API_BASE || 'http://103.69.87.202:5000');

    // ===== "/" — Serve Frontend =====
    if (path === '/' || path === '/index.html') {
      return new Response(HTML_PAGE, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // ===== GET /api/stock =====
    if (path === '/api/stock' && request.method === 'GET') {
      try {
        const result = await rawHttpRequest(apiHost, apiPort, 'GET', '/api/dealer/stock', {
          'X-API-KEY': env.API_KEY,
        });
        if (result.data.success) {
          result.data.products = filterProducts(result.data.products);
        }
        return jsonResponse(result.data, result.status, request);
      } catch (e) {
        return jsonResponse({ success: false, error: `Lỗi kết nối TCP: ${e.message}` }, 502, request);
      }
    }

    // ===== GET /api/balance =====
    if (path === '/api/balance' && request.method === 'GET') {
      try {
        const result = await rawHttpRequest(apiHost, apiPort, 'GET', '/api/dealer/balance', {
          'X-API-KEY': env.API_KEY,
        });
        return jsonResponse(result.data, result.status, request);
      } catch (e) {
        return jsonResponse({ success: false, error: `Lỗi kết nối: ${e.message}` }, 502, request);
      }
    }

    // ===== POST /api/buy =====
    if (path === '/api/buy' && request.method === 'POST') {
      try {
        const body = await request.json();
        if (!body.product_key || !ALLOWED_PRODUCTS.includes(body.product_key)) {
          return jsonResponse({ success: false, error: 'Sản phẩm không hợp lệ' }, 400, request);
        }
        if (!body.qty || body.qty < 1 || body.qty > 100) {
          return jsonResponse({ success: false, error: 'Số lượng không hợp lệ (1-100)' }, 400, request);
        }

        const bodyStr = JSON.stringify(body);
        const result = await rawHttpRequest(apiHost, apiPort, 'POST', '/api/dealer/buy', {
          'X-API-KEY': env.API_KEY,
          'Content-Type': 'application/json',
        }, bodyStr);
        return jsonResponse(result.data, result.status, request);
      } catch (e) {
        return jsonResponse({ success: false, error: `Lỗi: ${e.message}` }, 400, request);
      }
    }

    // ===== GET /api/debug =====
    if (path === '/api/debug' && request.method === 'GET') {
      let serverStatus = 'unknown';
      let rawResponse = '';
      let bytesReceived = 0;
      try {
        // Raw TCP debug — xem server trả về gì
        const socket = connect({ hostname: apiHost, port: apiPort });
        const writer = socket.writable.getWriter();
        const encoder = new TextEncoder();

        const reqStr = `GET /api/dealer/stock HTTP/1.1\r\nHost: ${apiHost}:${apiPort}\r\nX-API-KEY: ${env.API_KEY || 'test'}\r\nConnection: close\r\n\r\n`;
        await writer.write(encoder.encode(reqStr));
        await writer.close();

        const reader = socket.readable.getReader();
        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }

        bytesReceived = chunks.reduce((s, c) => s + c.length, 0);
        if (bytesReceived > 0) {
          const combined = new Uint8Array(bytesReceived);
          let offset = 0;
          for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
          rawResponse = new TextDecoder().decode(combined).substring(0, 500);
          serverStatus = 'OK - received data';
        } else {
          serverStatus = 'EMPTY - server returned 0 bytes';
        }
      } catch (e) {
        serverStatus = `FAILED: ${e.message}`;
      }

      return jsonResponse({
        api_host: apiHost,
        api_port: apiPort,
        api_key_set: env.API_KEY ? 'yes (' + env.API_KEY.substring(0, 8) + '...)' : 'no',
        server_test: serverStatus,
        bytes_received: bytesReceived,
        raw_response_preview: rawResponse,
        method: 'TCP raw socket'
      }, 200, request);
    }

    // ===== 404 =====
    return jsonResponse({ success: false, error: 'Route không tồn tại' }, 404, request);
  },
};

// ============================================
// FRONTEND HTML — Embedded
// ============================================
const HTML_PAGE = `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Shop ChatGPT & Grok — Giá Rẻ Nhất</title>
  <meta name="description" content="Mua tài khoản ChatGPT Plus, ChatGPT Team, Super Grok giá rẻ, bảo hành uy tín. Giao hàng tự động 24/7.">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-primary: #050816; --bg-secondary: #0c1024; --bg-card: #111631;
      --bg-card-hover: #161d42; --bg-glass: rgba(17,22,49,0.75);
      --border: rgba(99,102,241,0.15); --border-hover: rgba(99,102,241,0.35);
      --text-primary: #f1f5f9; --text-secondary: #94a3b8; --text-muted: #64748b;
      --accent-indigo: #6366f1; --accent-violet: #8b5cf6; --accent-cyan: #22d3ee;
      --accent-emerald: #10b981; --accent-amber: #f59e0b; --accent-rose: #f43f5e;
      --gradient-primary: linear-gradient(135deg, #6366f1, #8b5cf6, #a78bfa);
      --gradient-gpt: linear-gradient(135deg, #10b981, #22d3ee);
      --gradient-grok: linear-gradient(135deg, #f59e0b, #f43f5e);
      --gradient-team: linear-gradient(135deg, #3b82f6, #6366f1);
      --shadow-card: 0 4px 24px rgba(0,0,0,0.3), 0 0 0 1px rgba(99,102,241,0.08);
      --shadow-glow: 0 0 40px rgba(99,102,241,0.15);
      --radius-sm: 8px; --radius-md: 12px; --radius-lg: 16px;
      --radius-xl: 20px; --radius-pill: 50px;
    }
    *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
    html{scroll-behavior:smooth}
    body{background:var(--bg-primary);color:var(--text-primary);font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;line-height:1.6;min-height:100vh;overflow-x:hidden}
    body::before{content:'';position:fixed;top:0;left:0;right:0;bottom:0;background:radial-gradient(ellipse 80% 50% at 50% -20%,rgba(99,102,241,0.15),transparent),radial-gradient(ellipse 60% 40% at 80% 80%,rgba(139,92,246,0.08),transparent),radial-gradient(ellipse 40% 30% at 20% 60%,rgba(34,211,238,0.06),transparent);pointer-events:none;z-index:0}
    .wrapper{position:relative;z-index:1;max-width:1200px;margin:0 auto;padding:0 20px}
    
    /* Hero */
    .hero{text-align:center;padding:60px 0 40px;position:relative}
    .hero::after{content:'';position:absolute;bottom:0;left:50%;transform:translateX(-50%);width:200px;height:2px;background:var(--gradient-primary);border-radius:2px}
    .hero-badge{display:inline-flex;align-items:center;gap:6px;background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.2);padding:6px 16px;border-radius:var(--radius-pill);font-size:.78rem;font-weight:600;color:var(--accent-indigo);margin-bottom:16px;animation:pulse-badge 2s ease-in-out infinite}
    @keyframes pulse-badge{0%,100%{box-shadow:0 0 0 0 rgba(99,102,241,0.2)}50%{box-shadow:0 0 0 8px rgba(99,102,241,0)}}
    .hero h1{font-size:clamp(1.8rem,5vw,2.8rem);font-weight:900;background:var(--gradient-primary);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;letter-spacing:-0.03em;line-height:1.2;margin-bottom:12px}
    .hero p{color:var(--text-secondary);font-size:1rem;max-width:500px;margin:0 auto 20px}
    .hero-stats{display:flex;justify-content:center;gap:32px;margin-top:24px;flex-wrap:wrap}
    .stat{text-align:center}
    .stat-value{font-size:1.4rem;font-weight:800;color:var(--text-primary)}
    .stat-value.green{color:var(--accent-emerald)}.stat-value.blue{color:var(--accent-cyan)}.stat-value.amber{color:var(--accent-amber)}
    .stat-label{font-size:.75rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-top:2px}

    /* Categories */
    .categories{display:flex;justify-content:center;gap:10px;margin:32px 0 28px;flex-wrap:wrap}
    .cat-btn{padding:8px 20px;border-radius:var(--radius-pill);border:1px solid var(--border);background:var(--bg-card);color:var(--text-secondary);font-size:.85rem;font-weight:600;cursor:pointer;transition:all .3s ease;font-family:inherit}
    .cat-btn:hover{border-color:var(--border-hover);color:var(--text-primary);transform:translateY(-1px)}
    .cat-btn.active{background:var(--gradient-primary);border-color:transparent;color:white;box-shadow:0 4px 15px rgba(99,102,241,0.3)}

    /* Product Grid */
    .products-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:20px;margin-bottom:40px}
    
    /* Product Card */
    .product-card{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px;position:relative;overflow:hidden;transition:all .4s cubic-bezier(.4,0,.2,1);cursor:default}
    .product-card::before{content:'';position:absolute;top:0;left:0;right:0;height:3px;border-radius:var(--radius-lg) var(--radius-lg) 0 0}
    .product-card.gpt::before{background:var(--gradient-gpt)}.product-card.grok::before{background:var(--gradient-grok)}.product-card.team::before{background:var(--gradient-team)}
    .product-card:hover{border-color:var(--border-hover);transform:translateY(-4px);box-shadow:var(--shadow-card),var(--shadow-glow)}
    .card-header{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:16px}
    .card-icon{width:44px;height:44px;border-radius:var(--radius-md);display:flex;align-items:center;justify-content:center;font-size:1.4rem;flex-shrink:0}
    .card-icon.gpt{background:rgba(16,185,129,0.12)}.card-icon.grok{background:rgba(245,158,11,0.12)}.card-icon.team{background:rgba(59,130,246,0.12)}
    .card-tag{padding:3px 10px;border-radius:var(--radius-pill);font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.5px}
    .card-tag.bhf{background:rgba(16,185,129,0.12);color:var(--accent-emerald);border:1px solid rgba(16,185,129,0.2)}
    .card-tag.kbh{background:rgba(245,158,11,0.12);color:var(--accent-amber);border:1px solid rgba(245,158,11,0.2)}
    .card-tag.special{background:rgba(99,102,241,0.12);color:var(--accent-indigo);border:1px solid rgba(99,102,241,0.2)}
    .card-title{font-size:1.05rem;font-weight:700;color:var(--text-primary);margin-bottom:4px}
    .card-desc{font-size:.82rem;color:var(--text-muted);margin-bottom:16px;line-height:1.5}
    .card-meta{display:flex;align-items:center;justify-content:space-between;padding-top:16px;border-top:1px solid var(--border)}
    .card-price{font-size:1.3rem;font-weight:800;color:var(--text-primary)}
    .card-price span{font-size:.8rem;font-weight:500;color:var(--text-muted)}
    .card-stock{display:flex;align-items:center;gap:6px;font-size:.78rem;font-weight:600}
    .stock-dot{width:8px;height:8px;border-radius:50%;animation:pulse-dot 2s ease-in-out infinite}
    .stock-dot.available{background:var(--accent-emerald);box-shadow:0 0 8px rgba(16,185,129,0.5)}
    .stock-dot.out{background:var(--accent-rose);box-shadow:0 0 8px rgba(244,63,94,0.5)}
    .stock-dot.updating{background:var(--accent-amber);box-shadow:0 0 8px rgba(245,158,11,0.5)}
    @keyframes pulse-dot{0%,100%{opacity:1}50%{opacity:.5}}
    .stock-text.available{color:var(--accent-emerald)}.stock-text.out{color:var(--accent-rose)}.stock-text.updating{color:var(--accent-amber)}

    /* Buy Button */
    .buy-btn{width:100%;padding:12px;margin-top:16px;border:none;border-radius:var(--radius-md);font-family:inherit;font-size:.88rem;font-weight:700;cursor:pointer;transition:all .3s ease;position:relative;overflow:hidden}
    .buy-btn.gpt{background:var(--gradient-gpt);color:#fff}
    .buy-btn.grok{background:var(--gradient-grok);color:#fff}
    .buy-btn.team{background:var(--gradient-team);color:#fff}
    .buy-btn:hover{transform:translateY(-2px);box-shadow:0 6px 20px rgba(0,0,0,0.3)}
    .buy-btn:active{transform:translateY(0)}
    .buy-btn:disabled{opacity:.4;cursor:not-allowed;transform:none!important;box-shadow:none!important}

    /* Modal */
    .modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);backdrop-filter:blur(8px);z-index:1000;display:none;align-items:center;justify-content:center;padding:20px;animation:fadeIn .3s ease}
    .modal-overlay.show{display:flex}
    @keyframes fadeIn{from{opacity:0}to{opacity:1}}
    .modal{background:var(--bg-secondary);border:1px solid var(--border-hover);border-radius:var(--radius-xl);width:100%;max-width:480px;padding:32px;position:relative;animation:slideUp .4s cubic-bezier(.4,0,.2,1);box-shadow:0 25px 60px rgba(0,0,0,0.5)}
    @keyframes slideUp{from{opacity:0;transform:translateY(40px) scale(.95)}to{opacity:1;transform:translateY(0) scale(1)}}
    .modal-close{position:absolute;top:16px;right:16px;width:36px;height:36px;border-radius:50%;border:1px solid var(--border);background:var(--bg-card);color:var(--text-secondary);font-size:1.2rem;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all .2s}
    .modal-close:hover{background:var(--accent-rose);color:white;border-color:var(--accent-rose)}
    .modal h2{font-size:1.2rem;font-weight:700;margin-bottom:20px;padding-right:40px}
    .modal-product-info{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);padding:16px;margin-bottom:20px}
    .modal-product-name{font-weight:600;margin-bottom:4px}
    .modal-product-price{color:var(--accent-emerald);font-weight:700;font-size:1.1rem}
    .form-group{margin-bottom:16px}
    .form-group label{display:block;font-size:.82rem;font-weight:600;color:var(--text-secondary);margin-bottom:6px}
    .form-group input,.form-group textarea{width:100%;padding:10px 14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg-card);color:var(--text-primary);font-family:inherit;font-size:.9rem;transition:border-color .2s;outline:none}
    .form-group input:focus,.form-group textarea:focus{border-color:var(--accent-indigo);box-shadow:0 0 0 3px rgba(99,102,241,0.15)}
    .form-group textarea{min-height:80px;resize:vertical;font-family:'JetBrains Mono',monospace;font-size:.82rem}
    .form-group .hint{font-size:.75rem;color:var(--text-muted);margin-top:4px}
    .total-row{display:flex;justify-content:space-between;align-items:center;padding:14px 0;border-top:1px solid var(--border);margin-bottom:16px}
    .total-label{font-size:.9rem;font-weight:600;color:var(--text-secondary)}
    .total-value{font-size:1.2rem;font-weight:800;color:var(--accent-emerald)}
    .modal-buy-btn{width:100%;padding:14px;border:none;border-radius:var(--radius-md);background:var(--gradient-primary);color:white;font-family:inherit;font-size:.95rem;font-weight:700;cursor:pointer;transition:all .3s}
    .modal-buy-btn:hover{transform:translateY(-2px);box-shadow:0 8px 25px rgba(99,102,241,0.35)}
    .modal-buy-btn:disabled{opacity:.5;cursor:not-allowed;transform:none!important}

    /* Result */
    .result-box{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-md);padding:16px;margin:16px 0}
    .result-box.success{border-color:rgba(16,185,129,0.3);background:rgba(16,185,129,0.05)}
    .result-box.error{border-color:rgba(244,63,94,0.3);background:rgba(244,63,94,0.05)}
    .result-item{font-family:'JetBrains Mono',monospace;font-size:.82rem;padding:8px 12px;background:var(--bg-primary);border-radius:var(--radius-sm);margin:6px 0;word-break:break-all;color:var(--accent-cyan);position:relative;cursor:pointer;transition:background .2s}
    .result-item:hover{background:rgba(99,102,241,0.1)}
    .result-item::after{content:'📋';position:absolute;right:8px;top:50%;transform:translateY(-50%);opacity:0;transition:opacity .2s}
    .result-item:hover::after{opacity:1}
    .result-item.copied::after{content:'✅';opacity:1}

    /* Footer */
    .footer{text-align:center;padding:40px 0 32px;border-top:1px solid var(--border);margin-top:20px}
    .footer p{color:var(--text-muted);font-size:.82rem}
    .footer a{color:var(--accent-indigo);text-decoration:none;font-weight:600}
    .footer a:hover{color:var(--accent-violet)}
    .contact-links{display:flex;justify-content:center;gap:16px;margin-top:12px}
    .contact-link{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:var(--radius-pill);background:var(--bg-card);border:1px solid var(--border);color:var(--text-secondary);font-size:.78rem;font-weight:600;text-decoration:none;transition:all .2s}
    .contact-link:hover{border-color:var(--border-hover);color:var(--text-primary);transform:translateY(-1px)}

    /* Loading */
    .skeleton{background:linear-gradient(90deg,var(--bg-card) 25%,var(--bg-card-hover) 50%,var(--bg-card) 75%);background-size:200% 100%;animation:shimmer 1.5s infinite;border-radius:var(--radius-md)}
    @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
    .loading-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:20px}
    .skeleton-card{height:240px;border:1px solid var(--border)}

    /* Toast */
    .toast-container{position:fixed;top:20px;right:20px;z-index:2000;display:flex;flex-direction:column;gap:8px}
    .toast{padding:12px 20px;border-radius:var(--radius-md);font-size:.85rem;font-weight:600;color:white;animation:slideInRight .4s ease,fadeOut .4s ease 3s forwards;box-shadow:0 8px 24px rgba(0,0,0,0.4);max-width:360px}
    .toast.success{background:linear-gradient(135deg,#059669,#10b981)}
    .toast.error{background:linear-gradient(135deg,#dc2626,#f43f5e)}
    .toast.info{background:linear-gradient(135deg,#4f46e5,#6366f1)}
    @keyframes slideInRight{from{opacity:0;transform:translateX(60px)}to{opacity:1;transform:translateX(0)}}
    @keyframes fadeOut{to{opacity:0;transform:translateX(60px)}}

    /* Error / Empty State */
    .error-state{text-align:center;padding:60px 20px}
    .error-state .icon{font-size:3rem;margin-bottom:16px}
    .error-state h3{font-size:1.1rem;margin-bottom:8px}
    .error-state p{color:var(--text-secondary);font-size:.9rem;margin-bottom:20px}
    .retry-btn{padding:10px 24px;border:1px solid var(--border);border-radius:var(--radius-pill);background:var(--bg-card);color:var(--text-primary);font-family:inherit;font-size:.85rem;font-weight:600;cursor:pointer;transition:all .2s}
    .retry-btn:hover{border-color:var(--accent-indigo);box-shadow:0 0 15px rgba(99,102,241,0.2)}

    /* Balance bar */
    .balance-bar{background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:16px 24px;margin-bottom:28px;display:none;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
    .balance-bar.show{display:flex}
    .balance-info{display:flex;align-items:center;gap:12px;font-size:.88rem;color:var(--text-secondary)}
    .balance-info strong{color:var(--accent-emerald);font-size:1.1rem}
    .balance-info .dealer{color:var(--text-muted)}
    .refresh-btn{padding:6px 16px;border:1px solid var(--border);border-radius:var(--radius-pill);background:transparent;color:var(--text-secondary);font-family:inherit;font-size:.78rem;font-weight:600;cursor:pointer;transition:all .2s}
    .refresh-btn:hover{border-color:var(--accent-indigo);color:var(--text-primary)}

    /* Responsive */
    @media(max-width:768px){.hero{padding:40px 0 28px}.hero h1{font-size:1.6rem}.hero-stats{gap:20px}.products-grid{grid-template-columns:1fr}.modal{padding:24px;margin:10px}.categories{gap:6px}.cat-btn{padding:6px 14px;font-size:.8rem}}
    @media(max-width:400px){.wrapper{padding:0 12px}.product-card{padding:18px}}
    ::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:var(--bg-primary)}::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}::-webkit-scrollbar-thumb:hover{background:var(--accent-indigo)}
  </style>
</head>
<body>

<div class="wrapper">
  <section class="hero">
    <div class="hero-badge">🔥 Giao hàng tự động 24/7</div>
    <h1>ChatGPT & Grok Store</h1>
    <p>Tài khoản ChatGPT Plus, Team Business, Super Grok — Giá rẻ nhất, bảo hành uy tín.</p>
    <div class="hero-stats">
      <div class="stat"><div class="stat-value green" id="totalProducts">—</div><div class="stat-label">Sản phẩm</div></div>
      <div class="stat"><div class="stat-value blue" id="totalStock">—</div><div class="stat-label">Còn trong kho</div></div>
      <div class="stat"><div class="stat-value amber">24/7</div><div class="stat-label">Tự động</div></div>
    </div>
  </section>

  <div class="balance-bar" id="balanceBar">
    <div class="balance-info">
      💰 Số dư: <strong id="balanceValue">0đ</strong>
      <span class="dealer" id="dealerName"></span>
    </div>
    <button class="refresh-btn" onclick="loadStock()">🔄 Làm mới</button>
  </div>

  <div class="categories">
    <button class="cat-btn active" onclick="filterCategory('all', this)">🛍️ Tất cả</button>
    <button class="cat-btn" onclick="filterCategory('gpt', this)">💚 ChatGPT</button>
    <button class="cat-btn" onclick="filterCategory('grok', this)">🟠 Grok</button>
    <button class="cat-btn" onclick="filterCategory('team', this)">💙 Team / Admin</button>
  </div>

  <div id="productsContainer">
    <div class="loading-grid">
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
      <div class="skeleton skeleton-card"></div>
    </div>
  </div>

  <footer class="footer">
    <p>Liên hệ hỗ trợ — mua sỉ & hợp tác CTV</p>
    <div class="contact-links">
      <a href="https://t.me/longdt8386" class="contact-link" target="_blank">📱 Telegram</a>
      <a href="https://zalo.me/0948999915" class="contact-link" target="_blank">💬 Zalo</a>
    </div>
    <p style="margin-top:16px;font-size:.72rem;">© 2026 — Powered by Cloudflare Workers</p>
  </footer>
</div>

<!-- Order Modal -->
<div class="modal-overlay" id="orderModal">
  <div class="modal">
    <button class="modal-close" onclick="closeModal()">✕</button>
    <h2>🛒 Xác nhận mua hàng</h2>
    <div class="modal-product-info">
      <div class="modal-product-name" id="modalProductName">—</div>
      <div class="modal-product-price" id="modalProductPrice">—</div>
    </div>
    <div class="form-group">
      <label>Số lượng</label>
      <input type="number" id="modalQty" min="1" max="100" value="1" onchange="updateTotal()" oninput="updateTotal()">
    </div>
    <div class="form-group" id="emailGroup" style="display:none;">
      <label>Danh sách Email (mỗi email 1 dòng)</label>
      <textarea id="modalEmails" placeholder="user1@gmail.com&#10;user2@gmail.com"></textarea>
      <div class="hint">Số email phải bằng số lượng. Chỉ áp dụng cho Slot GPT Team.</div>
    </div>
    <div class="total-row">
      <span class="total-label">Tổng cộng</span>
      <span class="total-value" id="modalTotal">0đ</span>
    </div>
    <button class="modal-buy-btn" id="modalBuyBtn" onclick="confirmBuy()">⚡ Xác nhận mua</button>
  </div>
</div>

<!-- Result Modal -->
<div class="modal-overlay" id="resultModal">
  <div class="modal">
    <button class="modal-close" onclick="closeResultModal()">✕</button>
    <div id="resultContent"></div>
  </div>
</div>

<div class="toast-container" id="toastContainer"></div>

<script>
// === STATE ===
const API_BASE = window.location.origin; // Worker tự detect URL
let productsData = {};
let currentFilter = 'all';
let selectedProduct = null;

const PRODUCT_META = {
  gptplus_1thang_KBH: {cat:'gpt',icon:'💚',type:'gpt',tag:'KBH',tagClass:'kbh',desc:'Tài khoản ChatGPT Plus cá nhân, bảo hành 7 ngày.'},
  gptplus_1thang_BHF: {cat:'gpt',icon:'💚',type:'gpt',tag:'BHF',tagClass:'bhf',desc:'Tài khoản ChatGPT Plus cá nhân, bảo hành full (thay mới nếu die).'},
  slot_gpt_team:      {cat:'team',icon:'💙',type:'team',tag:'TEAM',tagClass:'special',desc:'Slot ChatGPT Team Business — cần gửi email khi mua.'},
  admingpt_bh:        {cat:'team',icon:'💙',type:'team',tag:'BHF',tagClass:'bhf',desc:'Admin GPT Team 7 Slot — bảo hành full.'},
  admingpt_kbh:       {cat:'team',icon:'💙',type:'team',tag:'KBH',tagClass:'kbh',desc:'Admin GPT Team 7 Slot — không bảo hành.'},
  cdkgpt_kbh:         {cat:'gpt',icon:'💚',type:'gpt',tag:'CDK',tagClass:'special',desc:'Code gia hạn GPT Plus 1 tháng — dùng CDK.'},
  supergrok_1thang_bhf:{cat:'grok',icon:'🟠',type:'grok',tag:'BHF',tagClass:'bhf',desc:'Super Grok 1 tháng — trọn bộ tính năng, bảo hành full.'},
  supergrok_1nam_bhf:  {cat:'grok',icon:'🟠',type:'grok',tag:'BHF',tagClass:'bhf',desc:'Super Grok 1 năm — siêu tiết kiệm, bảo hành full.'},
};

// === INIT ===
document.addEventListener('DOMContentLoaded', () => loadStock());

// === API ===
async function loadStock() {
  try {
    const resp = await fetch(API_BASE + '/api/stock');
    const data = await resp.json();
    if (data.success) {
      productsData = data.products;
      const keys = Object.keys(productsData);
      document.getElementById('totalProducts').textContent = keys.length;
      document.getElementById('totalStock').textContent = keys.reduce((s,k) => {const v=productsData[k].stock; return s+(v>0?v:0);}, 0);
      if (data.balance !== undefined) {
        document.getElementById('balanceBar').classList.add('show');
        document.getElementById('balanceValue').textContent = formatVND(data.balance);
      }
      if (data.dealer) document.getElementById('dealerName').textContent = '👤 ' + data.dealer;
      renderProducts();
      showToast('Kết nối thành công!', 'success');
    } else {
      showError(data.error || 'Lỗi không xác định');
    }
  } catch (e) {
    showError('Không kết nối được server: ' + e.message);
  }
}

async function buyProduct(productKey, qty, emails) {
  const body = {product_key: productKey, qty};
  if (emails && emails.length > 0) body.emails = emails;
  const resp = await fetch(API_BASE + '/api/buy', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
  });
  return await resp.json();
}

// === RENDER ===
function renderProducts() {
  const container = document.getElementById('productsContainer');
  const entries = Object.entries(productsData);
  if (!entries.length) { container.innerHTML = '<div class="error-state"><div class="icon">📦</div><h3>Không có sản phẩm</h3><p>Kho hàng đang trống.</p></div>'; return; }
  const filtered = entries.filter(([k]) => currentFilter==='all' || (PRODUCT_META[k] && PRODUCT_META[k].cat===currentFilter));
  if (!filtered.length) { container.innerHTML = '<div class="error-state"><div class="icon">🔍</div><h3>Không có sản phẩm trong danh mục này</h3></div>'; return; }
  let html = '<div class="products-grid">';
  for (const [key, product] of filtered) {
    const m = PRODUCT_META[key] || {cat:'gpt',icon:'📦',type:'gpt',tag:'—',tagClass:'special',desc:product.name};
    const stock = product.stock;
    let sc, st;
    if (stock > 0) { sc='available'; st='Còn '+stock; }
    else if (stock === 0) { sc='out'; st='Hết hàng'; }
    else { sc='updating'; st='Đang cập nhật'; }
    html += '<div class="product-card '+m.type+'" data-cat="'+m.cat+'">'
      + '<div class="card-header"><div class="card-icon '+m.type+'">'+m.icon+'</div><span class="card-tag '+m.tagClass+'">'+m.tag+'</span></div>'
      + '<div class="card-title">'+product.name+'</div>'
      + '<div class="card-desc">'+m.desc+'</div>'
      + '<div class="card-meta"><div class="card-price">'+formatVND(product.price)+' <span>/cái</span></div>'
      + '<div class="card-stock"><span class="stock-dot '+sc+'"></span><span class="stock-text '+sc+'">'+st+'</span></div></div>'
      + '<button class="buy-btn '+m.type+'" '+(stock>0?'':'disabled')+' onclick="openBuyModal(\\''+key+'\\')">'+(stock>0?'⚡ Mua ngay':'❌ Hết hàng')+'</button>'
      + '</div>';
  }
  html += '</div>';
  container.innerHTML = html;
}

function filterCategory(cat, btn) {
  currentFilter = cat;
  document.querySelectorAll('.cat-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderProducts();
}

// === MODAL ===
function openBuyModal(productKey) {
  selectedProduct = productKey;
  const p = productsData[productKey]; if (!p) return;
  document.getElementById('modalProductName').textContent = p.name;
  document.getElementById('modalProductPrice').textContent = formatVND(p.price) + ' / cái';
  document.getElementById('modalQty').value = 1;
  document.getElementById('modalQty').max = Math.min(p.stock, 100);
  document.getElementById('emailGroup').style.display = productKey==='slot_gpt_team' ? 'block' : 'none';
  document.getElementById('modalEmails').value = '';
  updateTotal();
  document.getElementById('orderModal').classList.add('show');
  document.getElementById('modalBuyBtn').disabled = false;
  document.getElementById('modalBuyBtn').textContent = '⚡ Xác nhận mua';
}
function closeModal() { document.getElementById('orderModal').classList.remove('show'); selectedProduct = null; }
function updateTotal() {
  if (!selectedProduct) return;
  const p = productsData[selectedProduct];
  const qty = parseInt(document.getElementById('modalQty').value) || 1;
  document.getElementById('modalTotal').textContent = formatVND(p.price * qty);
}

async function confirmBuy() {
  if (!selectedProduct) return;
  const qty = parseInt(document.getElementById('modalQty').value) || 1;
  let emails = null;
  if (selectedProduct === 'slot_gpt_team') {
    const t = document.getElementById('modalEmails').value.trim();
    if (!t) { showToast('Vui lòng nhập danh sách email!', 'error'); return; }
    emails = t.split('\\n').map(e => e.trim()).filter(e => e);
    if (emails.length !== qty) { showToast('Số email ('+emails.length+') phải bằng số lượng ('+qty+')!', 'error'); return; }
  }
  const btn = document.getElementById('modalBuyBtn');
  btn.disabled = true; btn.textContent = '⏳ Đang xử lý...';
  try {
    const result = await buyProduct(selectedProduct, qty, emails);
    closeModal();
    if (result.success) { showResultSuccess(result); showToast('✅ Mua hàng thành công!', 'success'); loadStock(); }
    else { showResultError(result.error || 'Lỗi không xác định'); showToast('❌ ' + result.error, 'error'); }
  } catch (e) { closeModal(); showResultError('Lỗi kết nối: ' + e.message); showToast('❌ Lỗi kết nối', 'error'); }
}

// === RESULT ===
function showResultSuccess(data) {
  const items = data.items || [];
  let ih = items.map(i => '<div class="result-item" onclick="copyItem(this,\\''+escapeAttr(i)+'\\')">' + esc(i) + '</div>').join('');
  document.getElementById('resultContent').innerHTML =
    '<h2>✅ Mua hàng thành công!</h2>'
    + '<div class="result-box success"><div style="margin-bottom:8px;font-size:.85rem;color:var(--text-secondary)">📦 <strong>' + data.product + '</strong> × ' + data.qty + ' • Trừ <strong style="color:var(--accent-rose)">' + formatVND(data.total_charged) + '</strong> • Còn <strong style="color:var(--accent-emerald)">' + formatVND(data.balance_remaining) + '</strong></div>'
    + '<div style="font-size:.75rem;color:var(--text-muted)">Mã đơn: ' + data.order_code + '</div></div>'
    + '<div style="margin-bottom:8px;font-size:.82rem;color:var(--text-secondary)">📋 Tài khoản (click để copy):</div>'
    + ih
    + '<button class="modal-buy-btn" style="margin-top:16px" onclick="copyAllItems()">📋 Copy tất cả</button>';
  document.getElementById('resultModal').classList.add('show');
}
function showResultError(error) {
  document.getElementById('resultContent').innerHTML =
    '<h2>❌ Mua hàng thất bại</h2><div class="result-box error"><p style="color:var(--accent-rose);font-weight:600">' + esc(error) + '</p></div>'
    + '<button class="modal-buy-btn" style="margin-top:16px" onclick="closeResultModal()">Đóng</button>';
  document.getElementById('resultModal').classList.add('show');
}
function closeResultModal() { document.getElementById('resultModal').classList.remove('show'); }

// === UTILS ===
function formatVND(a) { return a.toLocaleString('vi-VN') + 'đ'; }
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function escapeAttr(s) { return s.replace(/\\\\/g,'\\\\\\\\').replace(/'/g,"\\\\'").replace(/"/g,'\\\\"'); }
function copyItem(el, text) { navigator.clipboard.writeText(text).then(() => { el.classList.add('copied'); showToast('Đã copy!', 'success'); setTimeout(() => el.classList.remove('copied'), 1500); }); }
function copyAllItems() { const items = document.querySelectorAll('.result-item'); const t = Array.from(items).map(e => e.textContent).join('\\n'); navigator.clipboard.writeText(t).then(() => showToast('Đã copy tất cả!', 'success')); }
function showError(msg) { document.getElementById('productsContainer').innerHTML = '<div class="error-state"><div class="icon">❌</div><h3>Lỗi kết nối</h3><p>' + esc(msg) + '</p><button class="retry-btn" onclick="loadStock()">🔄 Thử lại</button></div>'; }
function showToast(message, type) {
  const c = document.getElementById('toastContainer');
  const t = document.createElement('div'); t.className = 'toast ' + (type||'info'); t.textContent = message;
  c.appendChild(t); setTimeout(() => t.remove(), 3500);
}
document.getElementById('orderModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeModal(); });
document.getElementById('resultModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeResultModal(); });
</script>
</body>
</html>`;
