const fs = require('fs');

const CONFIG_PATH = 'data/profiles-config.json';
const OUTPUT_PATH = 'data/profiles.json';

function safeJsonParse(s){ try{ return JSON.parse(s);}catch(e){return null;} }

async function fetchJson(url, opts){
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function fetchOg(url){
  const res = await fetch(url, { headers: { 'User-Agent': 'profile-updater-bot/1.0' } });
  const text = await res.text();
  const titleMatch = text.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
    || text.match(/<title>([^<]+)<\/title>/i);
  const imgMatch = text.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i)
    || text.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i);
  return {
    name: titleMatch ? titleMatch[1].trim() : null,
    avatar: imgMatch ? imgMatch[1].trim() : null,
    url
  };
}

async function fetchYouTube(entry){
  // Prefer API if key present
  const key = process.env.YOUTUBE_API_KEY;
  if (key){
    const idType = entry.idType === 'username' ? 'forUsername' : 'id';
    const q = entry.idType === 'username' ? `forUsername=${encodeURIComponent(entry.handle)}` : `id=${encodeURIComponent(entry.handle)}`;
    const url = `https://www.googleapis.com/youtube/v3/channels?part=snippet&${q}&key=${key}`;
    try{
      const j = await fetchJson(url);
      const item = (j.items && j.items[0]);
      if (item && item.snippet){
        return { name: item.snippet.title, avatar: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url, url: `https://www.youtube.com/channel/${item.id}` };
      }
    }catch(e){ console.error('YouTube API error', e.message); }
  }
  // Fallback: OG scraping
  const profileUrl = entry.profileUrl || (entry.idType === 'username' ? `https://www.youtube.com/@${entry.handle}` : `https://www.youtube.com/channel/${entry.handle}`);
  return fetchOg(profileUrl);
}

async function fetchFacebook(entry){
  const token = process.env.FACEBOOK_ACCESS_TOKEN;
  if (token){
    const id = entry.handle;
    const url = `https://graph.facebook.com/${id}?fields=name,picture.type(large)&access_token=${token}`;
    try{
      const j = await fetchJson(url);
      return { name: j.name, avatar: j.picture?.data?.url, url: entry.profileUrl || `https://www.facebook.com/${id}` };
    }catch(e){ console.error('Facebook API error', e.message); }
  }
  const profileUrl = entry.profileUrl || `https://www.facebook.com/${entry.handle}`;
  return fetchOg(profileUrl);
}

async function fetchTelegram(entry){
  const bot = process.env.TELEGRAM_BOT_TOKEN;
  if (bot){
    try{
      const username = entry.handle.startsWith('@') ? entry.handle : `@${entry.handle}`;
      const j = await fetchJson(`https://api.telegram.org/bot${bot}/getChat?chat_id=${encodeURIComponent(username)}`);
      if (j.ok && j.result){
        const name = j.result.title || j.result.first_name || j.result.username || null;
        let avatar = null;
        if (j.result.photo && j.result.photo.small_file_id){
          // try to get file path
          try{
            const fileRes = await fetchJson(`https://api.telegram.org/bot${bot}/getFile?file_id=${j.result.photo.small_file_id}`);
            if (fileRes.ok && fileRes.result && fileRes.result.file_path){
              avatar = `https://api.telegram.org/file/bot${bot}/${fileRes.result.file_path}`;
            }
          }catch(e){ /* ignore */ }
        }
        return { name, avatar, url: `https://t.me/${entry.handle.replace(/^@/,'')}` };
      }
    }catch(e){ console.error('Telegram API error', e.message); }
  }
  const profileUrl = entry.profileUrl || `https://t.me/${entry.handle.replace(/^@/,'')}`;
  return fetchOg(profileUrl);
}

async function fetchProfile(entry){
  try{
    if (entry.platform === 'youtube') return await fetchYouTube(entry);
    if (entry.platform === 'facebook') return await fetchFacebook(entry);
    if (entry.platform === 'telegram') return await fetchTelegram(entry);
    // generic fallback: OG
    if (entry.profileUrl) return await fetchOg(entry.profileUrl);
    throw new Error('No fetcher for platform');
  }catch(err){
    console.error(`fetchProfile error for ${entry.platform}/${entry.handle}:`, err.message);
    return { name: null, avatar: null, url: entry.profileUrl || null, error: err.message };
  }
}

(async()=>{
  if (!fs.existsSync(CONFIG_PATH)){
    console.error('Missing', CONFIG_PATH);
    process.exit(1);
  }
  const raw = fs.readFileSync(CONFIG_PATH,'utf8');
  const config = safeJsonParse(raw) || [];
  const results = [];
  for (const e of config){
    const r = await fetchProfile(e);
    results.push({ platform: e.platform, handle: e.handle, name: r.name || null, avatar: r.avatar || null, url: r.url || e.profileUrl || null, lastChecked: new Date().toISOString(), error: r.error || null });
  }
  const prev = fs.existsSync(OUTPUT_PATH) ? safeJsonParse(fs.readFileSync(OUTPUT_PATH,'utf8')) : null;
  const changed = JSON.stringify(prev) !== JSON.stringify(results);
  if (changed){
    fs.mkdirSync('data', { recursive: true });
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(results, null, 2), 'utf8');
    console.log('profiles updated');
  }else{
    console.log('no changes');
  }
})();
