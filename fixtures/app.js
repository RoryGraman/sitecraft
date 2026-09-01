// Fixture behavior. Adds a late element to test scripts that handle dynamic content.
(function () {
  var status = document.getElementById('status');
  var toggle = document.getElementById('theme-toggle');
  if (toggle) {
    toggle.addEventListener('click', function () {
      document.body.classList.toggle('dark');
    });
  }
  setTimeout(function () {
    var late = document.createElement('div');
    late.id = 'late-widget';
    late.className = 'promo';
    late.textContent = 'Late widget (added after 500 ms)';
    document.querySelector('main').appendChild(late);
    if (status) status.textContent = 'Ready';
    window.__sitecraftFixtureReady = true;
  }, 500);
})();
