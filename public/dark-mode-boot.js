(() => {
  try {
    const host = location.hostname.toLowerCase();
    const evaluate =
      host !== 'localhost' &&
      host !== '127.0.0.1' &&
      host !== '::1' &&
      !/^\d+\.\d+\.\d+\.\d+$/.test(host) &&
      !host.includes('pr-');

    let query = null;
    let stored = null;
    if (!evaluate) {
      query = new URLSearchParams(location.search).get('os_dark_mode');
      if (query === 'test' || query === 'control') {
        try {
          localStorage.setItem('os:dark-mode-default', query);
        } catch {
          // private mode
        }
      }
      try {
        stored = localStorage.getItem('os:dark-mode-default');
      } catch {
        // private mode
      }
    }

    const match = document.cookie.match(/(?:^|; )os_dark_mode_default=([^;]*)/);
    const variant = query || stored || (match && decodeURIComponent(match[1]));
    if (variant === 'test') {
      document.documentElement.classList.add('dark');
      document.documentElement.style.colorScheme = 'dark';
    } else if (variant === 'control') {
      document.documentElement.classList.remove('dark');
      document.documentElement.style.colorScheme = '';
    }
  } catch {
    // never block first paint
  }
})();
