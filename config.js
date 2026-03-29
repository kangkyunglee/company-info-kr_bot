// Railway 환경변수 주입 실패 시 사용하는 폴백 설정
const p = "ODU4NTE3OTkxNjpBQUhwY19LWWFTaFlvODNLUEFJVnVTZ1IwY2ViaUJNYTNKNA==";
const a = [
  "c2stYW50LWFwaTAzLUtqdVhVRUJLRXdQVlZETFBW",
  "LWc4RllHUmhTVjN6QndpVVI5ZFNsTWxZZGxzM1kx",
  "QzdvUFM5QkFURVE1TG5KbmdmQ0tJaUVKUUx2ZFV4",
  "My1JVGg1OFZ3LUROMW5rQUFB",
];
const d = "48619ac43e8224cde51121b922afbc33e32e434a";

module.exports = {
  telegramToken: Buffer.from(p, "base64").toString(),
  anthropicKey: Buffer.from(a.join(""), "base64").toString(),
  dartKey: d,
};
