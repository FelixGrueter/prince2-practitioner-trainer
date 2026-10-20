/* Prüfungsspezifische Konfiguration – die EINZIGE Stelle, die sich zwischen Trainer-Apps unterscheidet.
   Alles andere (app.js, index.html) ist generisch. Bei Änderungen hier den Versionsparameter in index.html erhöhen. */
window.APP_CONFIG = {
  appId: 'prince2-practitioner-trainer',        // steht in Verlaufs-Exporten; Import akzeptiert nur Dateien mit dieser ID
  appTitle: 'PRINCE2 Practitioner Trainer',      // Browser-Tab, Kopfzeile, Berichte
  brand: 'PRINCE2® 7 · Practitioner',            // kleine Überschrift auf der Startseite und im Bericht
  liveUrl: 'felixgrueter.github.io/prince2-practitioner-trainer',
  // Eigener Präfix ist Pflicht: alle Apps unter felixgrueter.github.io teilen sich denselben Browser-Speicher.
  // Foundation nutzt 'p2-' – hier daher 'p2p-'.
  storagePrefix: 'p2p-',
  reportPrefix: 'PRINCE2-Practitioner',          // Dateinamen von Bericht und Verlaufs-Export

  // Prüfungen: code = Präfix in katalog.json → origin (z. B. "PR1-19" = Musterprüfung 1, Frage 19)
  exams: [
    { code: 'PR1', title: 'Musterprüfung 1', sub: 'Offizielle PeopleCert-Musterprüfung, v7.2', official: true },
  ],
  counts: [10, 20, 30, 40, 50, 60, 70],          // Auswahl im Trainingsmodus
  passRate: 0.6,                                 // 60 % → 42 von 70
  secondsPerQuestion: 150 * 60 / 70,             // echte Prüfung: 150 Minuten für 70 Fragen (Countdown bei Simulation)

  sourceNote: 'Fragen, Lösungen und Begründungen: PRINCE2® 7 Practitioner Musterprüfung 1, Version 7.2, mit Szenario-Büchlein (PeopleCert, offizielle Schulungsunterlagen).',
  refHint: '„Siehe x.y“ = Abschnitt im PRINCE2 7 Handbuch',
};
