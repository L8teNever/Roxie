# Roxie

Discord-Bot für Freundes-Server mit lokaler Web-Oberfläche (ohne Login) zum Ein-/Ausschalten von Modulen.

## Module
- **Regeln akzeptiert**: Akzeptiert ein neuer User beim Beitritt die Server-Regeln, bekommt er die Rolle „Online“. Roxie legt sie selbst an und zeigt sie in der Mitgliederliste als eigene Gruppe an. Außerdem legt sie die Kategorie `Allgemein` mit dem Textkanal `#allgemein` und dem Sprachkanal `Talk` an, die nur diese Rolle sieht (ist `allgemein` schon vorhanden, bleibt alles unverändert).
- **Talk-Räume**: Wer den Sprachkanal `Talk` betritt, bekommt eine eigene Kategorie mit Sprachkanal (nach ihm benannt) Textkanal `chat` und Kanal `einstellungen` (nur für ihn sichtbar) und wird dorthin verschoben. Der Ersteller bekommt eine eigene Raum-Rolle (nur der Raumname, direkt unter der Trennrolle „Raum:“ einsortiert; gibt es nur, solange die Kategorie existiert) und Verwaltungsrechte für die Kategorie. In `einstellungen` stellt er per Button auf öffentlich (alle mit der Rolle „Online“ dürfen rein) oder privat um, wählt aus, welche User rein dürfen, und kann den Raum per Button sofort löschen. Ist der Raum leer, erscheint in der Kategorie ein gesperrter Textkanal `timer`, in dem nur ein großer Countdown (5:00 → 0:00) steht. Nach 5 Minuten werden Kanal und Kategorie gelöscht, kommt vorher jemand zurück, verschwindet der Countdown. Braucht den Kanal `Talk` (legt „Regeln akzeptiert“ an) und die Rechte **Mitglieder verschieben** und **Kanäle verwalten**.

## Setup
1. Bot im Discord Developer Portal anlegen, Token kopieren. Einladen mit den Rechten **Rollen verwalten** und **Kanäle verwalten**. Im Portal unter Bot den **Server Members Intent** aktivieren. Auf dem Server muss „Regeln-Screening“ (Community-Funktion) an sein.
2. Die Rolle „Online“ legt Roxie selbst an (der Bot braucht dafür **Rollen verwalten** und **Kanäle verwalten**).
3. `.env.example` nach `.env` kopieren und Token eintragen.
4. `docker compose up -d` – das Image kommt aus `ghcr.io/l8tenever/roxie` (wird per GitHub Action bei jedem Push auf `main` gebaut).
5. Web-Oberfläche: `http://<host>:3000`. **Keine Anmeldung** – nur im lokalen Netz betreiben, nicht ins Internet stellen.

## Neues Modul
Datei in `src/modules/` anlegen (`id`, `name`, `description`, `settings`, `register(client, config)`) und in `src/modules/index.js` eintragen.
