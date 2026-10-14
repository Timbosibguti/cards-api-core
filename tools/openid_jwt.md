### Правила работы с openid сервисом

- Все расширения из внешнего мира должны общаться с микросервисами через openid gateway.
- Адрес гейтвея: https://openid-main.groscloud.com/
- JWT через openid работает не как полноценный OIDC/JWKS, а как свой gateway с кастомным JWT.
- Клиент ходит не на сервис, а через openid, например https://openid.groscloud.com/<target-service>/.... Сам gateway достаёт токен из Authorization: Bearer ... или из ?jwt= и валидирует его 

В openid JWT проверяется по кастомной схеме:

- токен декодируется;
- проверяется срок жизни;
- если в payload есть email, gateway ищет пользователя в БД и проверяет подпись по его sid;
- если в payload есть только profile_id, gateway сначала вычисляет текущий email владельца профиля через Farm DB, потом уже работает с этим пользователем.
- Подпись тут не стандартная библиотечная HS256, а свой simpleHash(header.payload.sid)
- После успешной проверки openid проксирует запрос дальше в микросервис и заново ставит Authorization: Bearer <finalToken>. Если токен был с profile_id, gateway может сгенерировать новый токен уже с email и прокинуть его дальше. Плюс добавляет X-OpenID-Full с именем пользователя.

есть псевдо-функция создания JWT по двум параметрам:
email + sid, если мы работаем в ретуле
profile_id + profile_name, если мы работаем в

# Функция генерации псевдо JWT токена 
function generateJwt(profile_id, sid) {
  function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return hash.toString(36);
  }

  function base64urlEncode(str) {
    const base64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = '';
    let i = 0;
    while (i < str.length) {
      const a = str.charCodeAt(i++);
      const b = i < str.length ? str.charCodeAt(i++) : 0;
      const c = i < str.length ? str.charCodeAt(i++) : 0;
      const bitmap = (a << 16) | (b << 8) | c;
      result += base64chars.charAt((bitmap >> 18) & 63);
      result += base64chars.charAt((bitmap >> 12) & 63);
      result += base64chars.charAt((bitmap >> 6) & 63);
      result += base64chars.charAt(bitmap & 63);
    }
    const padding = str.length % 3;
    if (padding > 0) result = result.slice(0, padding - 3);
    return result.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  if (!profile_id || !sid) return null;

  const header = JSON.stringify({ alg: "HS256", typ: "JWT" });
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ profile_id, iat: now, exp: now + 300 });
  const encodedHeader = base64urlEncode(header);
  const encodedPayload = base64urlEncode(payload);
  const signature = simpleHash(encodedHeader + '.' + encodedPayload + '.' + sid);
  const encodedSignature = base64urlEncode(signature);

  return encodedHeader + '.' + encodedPayload + '.' + encodedSignature;
}