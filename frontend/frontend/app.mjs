document.addEventListener('DOMContentLoaded', () => {
  const tabs = document.querySelectorAll('.screen-tab');
  const panels = document.querySelectorAll('.panel');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      if (tab.disabled) return;
      const targetId = tab.dataset.target;
      
      tabs.forEach(t => t.removeAttribute('aria-current'));
      tab.setAttribute('aria-current', 'page');
      
      panels.forEach(p => {
        if (p.id === targetId) {
          p.removeAttribute('hidden');
        } else {
          p.setAttribute('hidden', '');
        }
      });
    });
  });
});
