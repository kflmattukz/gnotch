UUID = gnotch@mattukz
DEST = $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
FILES = metadata.json extension.js prefs.js stylesheet.css src schemas

.PHONY: schemas install link uninstall zip nested log

schemas:
	glib-compile-schemas schemas/

install: schemas
	rm -rf $(DEST)
	mkdir -p $(DEST)
	cp -r $(FILES) $(DEST)/

# Symlink the working tree so edits apply after a shell restart
link: schemas
	rm -rf $(DEST)
	ln -s $(CURDIR) $(DEST)

uninstall:
	rm -rf $(DEST)

zip: schemas
	gnome-extensions pack --force --extra-source=src --schema=schemas/org.gnome.shell.extensions.gnotch.gschema.xml .

# Nested GNOME Shell for testing on Wayland without logging out
nested:
	dbus-run-session gnome-shell --devkit

log:
	journalctl -f -o cat /usr/bin/gnome-shell
