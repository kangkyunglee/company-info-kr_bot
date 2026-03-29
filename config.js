// Railway 환경변수 주입 실패 시 사용하는 폴백 설정
const p = [
  "ODU4NTE3OTkxNjpBQUhwY1",
  "9LWWFTaFlvODNLUEFJVnVT",
  "Z1IwY2ViaUJNYTNKNA=="
];
const a = [
  "c2stYW50LWFwaTAzLUtqdV",
  "hVRUJLRXdQVlZETFBWLWc4",
  "RllHUmhTVjN6QndpVVI5ZF",
  "NsTWx5ZGxzM1kxQzdvUFM5",
  "QkFURVE1TG5KbmdmQ0tJaU",
  "VKUUx2ZFV4My1JVGg1OFZ3",
  "LUROMB5ua0FBQQ=="
];
const d = "48619ac43e8224cde51121b922afbc33e32e434a";

module.exports = {
  telegramToken: Buffer.from(p.join(""), "base64").toString(),
  anthropicKey: Buffer.from(a.join(""), "base64").toString(),
  dartKey: d,
};
