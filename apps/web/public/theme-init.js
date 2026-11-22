// 저장된 테마(없으면 시스템 설정)를 첫 렌더 전에 적용한다.
(function () {
  try {
    var saved = localStorage.getItem('psk-theme');
    var dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {
    /* 저장소를 쓸 수 없으면 기본(라이트) */
  }
})();
