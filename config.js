/* Prüfungsspezifische Konfiguration – die EINZIGE Stelle, die sich zwischen Trainer-Apps unterscheidet.
   Alles andere (app.js, index.html) ist generisch. Bei Änderungen hier den Versionsparameter in index.html erhöhen. */
window.APP_CONFIG = {
  appId: 'prince2-practitioner-trainer',        // steht in Verlaufs-Exporten; Import akzeptiert nur Dateien mit dieser ID
  appTitle: 'PRINCE2 Practitioner Trainer',      // Browser-Tab, Kopfzeile, Berichte
  brand: 'PRINCE2® 7 · Practitioner',            // kleine Überschrift auf der Startseite und im Bericht
  liveUrl: 'felixgrueter.github.io/prince2-practitioner-trainer',
  // Kopfzeile: Logo (zugeschnitten, 2-fache Auflösung) + Wort daneben im Stil der Wortmarke; ohne logo das Standard-Logo
  logo: 'img/logo-prince2.png',
  brandWord: 'Practitioner',
  brandColor: '#29bca3',                         // Türkis der PRINCE2-Wortmarke (aus dem Logo gemessen)
  // Links in der Kopfzeile zu verwandten Trainer-Apps (öffnen in neuem Tab)
  otherApps: [
    { label: 'Foundation', title: 'PRINCE2 Foundation Trainer – öffnet in neuem Tab', url: 'https://felixgrueter.github.io/prince2-foundation-trainer/' },
  ],
  // Eigener Präfix ist Pflicht: alle Apps unter felixgrueter.github.io teilen sich denselben Browser-Speicher.
  // Foundation nutzt 'p2-' – hier daher 'p2p-'.
  storagePrefix: 'p2p-',
  reportPrefix: 'PRINCE2-Practitioner',          // Dateinamen von Bericht und Verlaufs-Export

  // Prüfungen: code = Präfix in katalog.json → origin (z. B. "PR1-19" = Musterprüfung 1, Frage 19)
  exams: [
    { code: 'PR1', title: 'Musterprüfung 1', sub: 'Offizielle PeopleCert-Musterprüfung, v7.2', official: true },
    { code: 'PR2', title: 'Musterprüfung 2', sub: 'Offizielle PeopleCert-Musterprüfung, v7.2', official: true },
  ],
  countStep: 10,                                 // Schieberegler im Trainingsmodus: 10er-Schritte bis zur Katalogsgröße (rechts = „Alle“)
  passRate: 0.6,                                 // 60 % → 42 von 70
  secondsPerQuestion: 150 * 60 / 70,             // echte Prüfung: 150 Minuten für 70 Fragen (Countdown bei Simulation)

  sourceNote: 'Fragen, Lösungen und Begründungen: PRINCE2® 7 Practitioner Musterprüfung 1 und 2 (jeweils Version 7.2), mit Szenario-Büchlein (PeopleCert, offizielle Schulungsunterlagen).',
  refHint: '„Siehe x.y“ = Abschnitt im PRINCE2 7 Handbuch',
};
