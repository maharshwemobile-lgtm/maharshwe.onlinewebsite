(() => {
  const applyTheme = () => {
    const saved = localStorage.getItem('ms_theme') || 'dark';
    document.documentElement.dataset.msTheme = saved === 'light' ? 'light' : 'dark';
  };

  const addControls = () => {
    const header = document.querySelector('header');
    if (!header || document.querySelector('[data-ms-theme-toggle]')) return;
    const rightArea = header.querySelector('.flex.flex-wrap.items-center.gap-3') || header.lastElementChild;
    if (!rightArea) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.msThemeToggle = 'true';
    btn.className = 'ms-theme-toggle';
    btn.innerHTML = (localStorage.getItem('ms_theme') === 'light') ? '🌙 Dark Mode' : '☀️ Light Mode';
    btn.addEventListener('click', () => {
      const next = (localStorage.getItem('ms_theme') === 'light') ? 'dark' : 'light';
      localStorage.setItem('ms_theme', next);
      document.documentElement.dataset.msTheme = next;
      btn.innerHTML = next === 'light' ? '🌙 Dark Mode' : '☀️ Light Mode';
      setTimeout(() => location.reload(), 120);
    });
    rightArea.prepend(btn);
  };

  const improveBrand = () => {
    const imgs = [...document.querySelectorAll('img')];
    imgs.forEach((img) => {
      if ((img.alt || '').includes('မဟာရွှေ') || img.className.includes('rounded')) {
        img.classList.add('ms-brand-logo');
        img.src = './maharshwe-logo.svg';
      }
    });

    const headings = [...document.querySelectorAll('h1')];
    headings.forEach((h) => {
      if (h.textContent.includes('မဟာရွှေ') || h.textContent.includes('Mahar')) {
        h.classList.add('ms-brand-title');
      }
    });

    [...document.querySelectorAll('button')].forEach((btn) => {
      const text = btn.textContent || '';
      if (text.includes('English') || text.includes('မြန်မာ')) btn.classList.add('ms-lang-button');
    });
  };

  const tick = () => {
    applyTheme();
    addControls();
    improveBrand();
  };

  document.addEventListener('DOMContentLoaded', () => {
    tick();
    const mo = new MutationObserver(tick);
    mo.observe(document.body, { childList: true, subtree: true });
  });
})();
