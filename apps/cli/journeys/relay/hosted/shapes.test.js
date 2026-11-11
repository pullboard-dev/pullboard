// pullboard: browser
/** @pullboard-test-gui */
/**
 * Every shape of opening a board through pullboard.dev, in real Chromium and real WebKit [H5,H17,N26].
 *
 * Each cell is one of: where the browser is (the computer with the boards, its view running or not; another
 * computer; a phone) x the account (signed out, signed in) x this browser (paired, not paired, revoked) x the
 * boards (none linked, excluded, healthy, over the size limit, waiting for a phone approval, mixed) x what the
 * browser has stored (fresh, a stale pairing link, a stale board key). Each runs with the real CLI, a real local
 * relay, a real `pullboard view` and real browsers, and must show the board within 3 s, or name its exact blocker
 * and the one step that clears it, never a step the person already took. A cell that fails is a filed defect,
 * listed in KNOWN_DEFECTS with its item; the matrix fails on any other failing cell, and on a listed cell that now
 * passes, so the list stays true. Every cell and the screen it must reach:
 *
 * CELLS-START
 * board-view/signed-out/paired/none/fresh: the board within 3 s (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * board-view/signed-out/paired/none/stale-pairing: the board within 3 s (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * board-view/signed-out/paired/none/stale-key: the board within 3 s (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * board-view/signed-out/unpaired/none/fresh: the board within 3 s
 * board-view/signed-out/unpaired/none/stale-pairing: the board within 3 s
 * board-view/signed-out/unpaired/none/stale-key: the board within 3 s
 * board-view/signed-out/revoked/none/fresh: the board within 3 s (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * board-view/signed-out/revoked/none/stale-pairing: the board within 3 s (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * board-view/signed-out/revoked/none/stale-key: the board within 3 s (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * board-view/signed-in/paired/none/fresh: the board within 3 s (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * board-view/signed-in/paired/none/stale-pairing: the board within 3 s (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * board-view/signed-in/paired/none/stale-key: the board within 3 s (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * board-view/signed-in/unpaired/none/fresh: the board within 3 s
 * board-view/signed-in/unpaired/none/stale-pairing: the board within 3 s
 * board-view/signed-in/unpaired/none/stale-key: the board within 3 s
 * board-view/signed-in/revoked/none/fresh: the board within 3 s (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * board-view/signed-in/revoked/none/stale-pairing: the board within 3 s (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * board-view/signed-in/revoked/none/stale-key: the board within 3 s (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * board-no-view/signed-out/paired/none/fresh: names sign-in and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * board-no-view/signed-out/paired/none/stale-pairing: names sign-in and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * board-no-view/signed-out/paired/none/stale-key: names sign-in and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * board-no-view/signed-out/unpaired/none/fresh: names sign-in and the one step that clears it
 * board-no-view/signed-out/unpaired/none/stale-pairing: names sign-in and the one step that clears it
 * board-no-view/signed-out/unpaired/none/stale-key: names sign-in and the one step that clears it
 * board-no-view/signed-out/revoked/none/fresh: names sign-in and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * board-no-view/signed-out/revoked/none/stale-pairing: names sign-in and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * board-no-view/signed-out/revoked/none/stale-key: names sign-in and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * board-no-view/signed-in/paired/none/fresh: names not-linked and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * board-no-view/signed-in/paired/none/stale-pairing: names not-linked and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * board-no-view/signed-in/paired/none/stale-key: names not-linked and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * board-no-view/signed-in/unpaired/none/fresh: names not-linked and the one step that clears it
 * board-no-view/signed-in/unpaired/none/stale-pairing: names not-linked and the one step that clears it
 * board-no-view/signed-in/unpaired/none/stale-key: names not-linked and the one step that clears it
 * board-no-view/signed-in/revoked/none/fresh: names not-linked and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * board-no-view/signed-in/revoked/none/stale-pairing: names not-linked and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * board-no-view/signed-in/revoked/none/stale-key: names not-linked and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * other-computer/signed-out/paired/none/fresh: names sign-in and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * other-computer/signed-out/paired/none/stale-pairing: names sign-in and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * other-computer/signed-out/paired/none/stale-key: names sign-in and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * other-computer/signed-out/unpaired/none/fresh: names sign-in and the one step that clears it
 * other-computer/signed-out/unpaired/none/stale-pairing: names sign-in and the one step that clears it
 * other-computer/signed-out/unpaired/none/stale-key: names sign-in and the one step that clears it
 * other-computer/signed-out/revoked/none/fresh: names sign-in and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * other-computer/signed-out/revoked/none/stale-pairing: names sign-in and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * other-computer/signed-out/revoked/none/stale-key: names sign-in and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * other-computer/signed-in/paired/none/fresh: names not-linked and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * other-computer/signed-in/paired/none/stale-pairing: names not-linked and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * other-computer/signed-in/paired/none/stale-key: names not-linked and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * other-computer/signed-in/unpaired/none/fresh: names not-linked and the one step that clears it
 * other-computer/signed-in/unpaired/none/stale-pairing: names not-linked and the one step that clears it
 * other-computer/signed-in/unpaired/none/stale-key: names not-linked and the one step that clears it
 * other-computer/signed-in/revoked/none/fresh: names not-linked and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * other-computer/signed-in/revoked/none/stale-pairing: names not-linked and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * other-computer/signed-in/revoked/none/stale-key: names not-linked and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * phone/signed-out/paired/none/fresh: names sign-in and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * phone/signed-out/paired/none/stale-pairing: names sign-in and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * phone/signed-out/paired/none/stale-key: names sign-in and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * phone/signed-out/unpaired/none/fresh: names sign-in and the one step that clears it
 * phone/signed-out/unpaired/none/stale-pairing: names sign-in and the one step that clears it
 * phone/signed-out/unpaired/none/stale-key: names sign-in and the one step that clears it
 * phone/signed-out/revoked/none/fresh: names sign-in and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * phone/signed-out/revoked/none/stale-pairing: names sign-in and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * phone/signed-out/revoked/none/stale-key: names sign-in and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * phone/signed-in/paired/none/fresh: names not-linked and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * phone/signed-in/paired/none/stale-pairing: names not-linked and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * phone/signed-in/paired/none/stale-key: names not-linked and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * phone/signed-in/unpaired/none/fresh: names not-linked and the one step that clears it
 * phone/signed-in/unpaired/none/stale-pairing: names not-linked and the one step that clears it
 * phone/signed-in/unpaired/none/stale-key: names not-linked and the one step that clears it
 * phone/signed-in/revoked/none/fresh: names not-linked and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * phone/signed-in/revoked/none/stale-pairing: names not-linked and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * phone/signed-in/revoked/none/stale-key: names not-linked and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * board-view/signed-out/paired/excluded/fresh: the board within 3 s (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * board-view/signed-out/paired/excluded/stale-pairing: the board within 3 s (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * board-view/signed-out/paired/excluded/stale-key: the board within 3 s (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * board-view/signed-out/unpaired/excluded/fresh: the board within 3 s
 * board-view/signed-out/unpaired/excluded/stale-pairing: the board within 3 s
 * board-view/signed-out/unpaired/excluded/stale-key: the board within 3 s
 * board-view/signed-out/revoked/excluded/fresh: the board within 3 s (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * board-view/signed-out/revoked/excluded/stale-pairing: the board within 3 s (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * board-view/signed-out/revoked/excluded/stale-key: the board within 3 s (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * board-view/signed-in/paired/excluded/fresh: the board within 3 s (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * board-view/signed-in/paired/excluded/stale-pairing: the board within 3 s (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * board-view/signed-in/paired/excluded/stale-key: the board within 3 s (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * board-view/signed-in/unpaired/excluded/fresh: the board within 3 s
 * board-view/signed-in/unpaired/excluded/stale-pairing: the board within 3 s
 * board-view/signed-in/unpaired/excluded/stale-key: the board within 3 s
 * board-view/signed-in/revoked/excluded/fresh: the board within 3 s (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * board-view/signed-in/revoked/excluded/stale-pairing: the board within 3 s (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * board-view/signed-in/revoked/excluded/stale-key: the board within 3 s (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * board-no-view/signed-out/paired/excluded/fresh: names sign-in and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * board-no-view/signed-out/paired/excluded/stale-pairing: names sign-in and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * board-no-view/signed-out/paired/excluded/stale-key: names sign-in and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * board-no-view/signed-out/unpaired/excluded/fresh: names sign-in and the one step that clears it
 * board-no-view/signed-out/unpaired/excluded/stale-pairing: names sign-in and the one step that clears it
 * board-no-view/signed-out/unpaired/excluded/stale-key: names sign-in and the one step that clears it
 * board-no-view/signed-out/revoked/excluded/fresh: names sign-in and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * board-no-view/signed-out/revoked/excluded/stale-pairing: names sign-in and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * board-no-view/signed-out/revoked/excluded/stale-key: names sign-in and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * board-no-view/signed-in/paired/excluded/fresh: names excluded and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * board-no-view/signed-in/paired/excluded/stale-pairing: names excluded and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * board-no-view/signed-in/paired/excluded/stale-key: names excluded and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * board-no-view/signed-in/unpaired/excluded/fresh: names excluded and the one step that clears it
 * board-no-view/signed-in/unpaired/excluded/stale-pairing: names excluded and the one step that clears it
 * board-no-view/signed-in/unpaired/excluded/stale-key: names excluded and the one step that clears it
 * board-no-view/signed-in/revoked/excluded/fresh: names excluded and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * board-no-view/signed-in/revoked/excluded/stale-pairing: names excluded and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * board-no-view/signed-in/revoked/excluded/stale-key: names excluded and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * other-computer/signed-out/paired/excluded/fresh: names sign-in and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * other-computer/signed-out/paired/excluded/stale-pairing: names sign-in and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * other-computer/signed-out/paired/excluded/stale-key: names sign-in and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * other-computer/signed-out/unpaired/excluded/fresh: names sign-in and the one step that clears it
 * other-computer/signed-out/unpaired/excluded/stale-pairing: names sign-in and the one step that clears it
 * other-computer/signed-out/unpaired/excluded/stale-key: names sign-in and the one step that clears it
 * other-computer/signed-out/revoked/excluded/fresh: names sign-in and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * other-computer/signed-out/revoked/excluded/stale-pairing: names sign-in and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * other-computer/signed-out/revoked/excluded/stale-key: names sign-in and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * other-computer/signed-in/paired/excluded/fresh: names excluded and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * other-computer/signed-in/paired/excluded/stale-pairing: names excluded and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * other-computer/signed-in/paired/excluded/stale-key: names excluded and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * other-computer/signed-in/unpaired/excluded/fresh: names excluded and the one step that clears it
 * other-computer/signed-in/unpaired/excluded/stale-pairing: names excluded and the one step that clears it
 * other-computer/signed-in/unpaired/excluded/stale-key: names excluded and the one step that clears it
 * other-computer/signed-in/revoked/excluded/fresh: names excluded and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * other-computer/signed-in/revoked/excluded/stale-pairing: names excluded and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * other-computer/signed-in/revoked/excluded/stale-key: names excluded and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * phone/signed-out/paired/excluded/fresh: names sign-in and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * phone/signed-out/paired/excluded/stale-pairing: names sign-in and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * phone/signed-out/paired/excluded/stale-key: names sign-in and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * phone/signed-out/unpaired/excluded/fresh: names sign-in and the one step that clears it
 * phone/signed-out/unpaired/excluded/stale-pairing: names sign-in and the one step that clears it
 * phone/signed-out/unpaired/excluded/stale-key: names sign-in and the one step that clears it
 * phone/signed-out/revoked/excluded/fresh: names sign-in and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * phone/signed-out/revoked/excluded/stale-pairing: names sign-in and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * phone/signed-out/revoked/excluded/stale-key: names sign-in and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * phone/signed-in/paired/excluded/fresh: names excluded and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * phone/signed-in/paired/excluded/stale-pairing: names excluded and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * phone/signed-in/paired/excluded/stale-key: names excluded and the one step that clears it (cannot exist: pairing hands a browser the key of a linked board; with no board linked there is no key to hold; runs as unpaired)
 * phone/signed-in/unpaired/excluded/fresh: names excluded and the one step that clears it
 * phone/signed-in/unpaired/excluded/stale-pairing: names excluded and the one step that clears it
 * phone/signed-in/unpaired/excluded/stale-key: names excluded and the one step that clears it
 * phone/signed-in/revoked/excluded/fresh: names excluded and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * phone/signed-in/revoked/excluded/stale-pairing: names excluded and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * phone/signed-in/revoked/excluded/stale-key: names excluded and the one step that clears it (cannot exist: only an enrolled browser can be revoked, and relay on --all enrolls one only while it links a board; runs as unpaired)
 * board-view/signed-out/paired/healthy/fresh: the board within 3 s
 * board-view/signed-out/paired/healthy/stale-pairing: the board within 3 s
 * board-view/signed-out/paired/healthy/stale-key: the board within 3 s
 * board-view/signed-out/unpaired/healthy/fresh: the board within 3 s
 * board-view/signed-out/unpaired/healthy/stale-pairing: the board within 3 s
 * board-view/signed-out/unpaired/healthy/stale-key: the board within 3 s
 * board-view/signed-out/revoked/healthy/fresh: the board within 3 s
 * board-view/signed-out/revoked/healthy/stale-pairing: the board within 3 s
 * board-view/signed-out/revoked/healthy/stale-key: the board within 3 s
 * board-view/signed-in/paired/healthy/fresh: the board within 3 s
 * board-view/signed-in/paired/healthy/stale-pairing: the board within 3 s
 * board-view/signed-in/paired/healthy/stale-key: the board within 3 s
 * board-view/signed-in/unpaired/healthy/fresh: the board within 3 s
 * board-view/signed-in/unpaired/healthy/stale-pairing: the board within 3 s
 * board-view/signed-in/unpaired/healthy/stale-key: the board within 3 s
 * board-view/signed-in/revoked/healthy/fresh: the board within 3 s
 * board-view/signed-in/revoked/healthy/stale-pairing: the board within 3 s
 * board-view/signed-in/revoked/healthy/stale-key: the board within 3 s
 * board-no-view/signed-out/paired/healthy/fresh: names sign-in and the one step that clears it
 * board-no-view/signed-out/paired/healthy/stale-pairing: names sign-in and the one step that clears it
 * board-no-view/signed-out/paired/healthy/stale-key: names sign-in and the one step that clears it
 * board-no-view/signed-out/unpaired/healthy/fresh: names sign-in and the one step that clears it
 * board-no-view/signed-out/unpaired/healthy/stale-pairing: names sign-in and the one step that clears it
 * board-no-view/signed-out/unpaired/healthy/stale-key: names sign-in and the one step that clears it
 * board-no-view/signed-out/revoked/healthy/fresh: names sign-in and the one step that clears it
 * board-no-view/signed-out/revoked/healthy/stale-pairing: names sign-in and the one step that clears it
 * board-no-view/signed-out/revoked/healthy/stale-key: names sign-in and the one step that clears it
 * board-no-view/signed-in/paired/healthy/fresh: the board within 3 s
 * board-no-view/signed-in/paired/healthy/stale-pairing: the board within 3 s
 * board-no-view/signed-in/paired/healthy/stale-key: names stale-key and the one step that clears it
 * board-no-view/signed-in/unpaired/healthy/fresh: names unpaired and the one step that clears it
 * board-no-view/signed-in/unpaired/healthy/stale-pairing: names unpaired and the one step that clears it
 * board-no-view/signed-in/unpaired/healthy/stale-key: names unpaired and the one step that clears it
 * board-no-view/signed-in/revoked/healthy/fresh: names removed and the one step that clears it
 * board-no-view/signed-in/revoked/healthy/stale-pairing: names removed and the one step that clears it
 * board-no-view/signed-in/revoked/healthy/stale-key: names removed and the one step that clears it
 * other-computer/signed-out/paired/healthy/fresh: names sign-in and the one step that clears it
 * other-computer/signed-out/paired/healthy/stale-pairing: names sign-in and the one step that clears it
 * other-computer/signed-out/paired/healthy/stale-key: names sign-in and the one step that clears it
 * other-computer/signed-out/unpaired/healthy/fresh: names sign-in and the one step that clears it
 * other-computer/signed-out/unpaired/healthy/stale-pairing: names sign-in and the one step that clears it
 * other-computer/signed-out/unpaired/healthy/stale-key: names sign-in and the one step that clears it
 * other-computer/signed-out/revoked/healthy/fresh: names sign-in and the one step that clears it
 * other-computer/signed-out/revoked/healthy/stale-pairing: names sign-in and the one step that clears it
 * other-computer/signed-out/revoked/healthy/stale-key: names sign-in and the one step that clears it
 * other-computer/signed-in/paired/healthy/fresh: the board within 3 s
 * other-computer/signed-in/paired/healthy/stale-pairing: the board within 3 s
 * other-computer/signed-in/paired/healthy/stale-key: names stale-key and the one step that clears it
 * other-computer/signed-in/unpaired/healthy/fresh: names unpaired and the one step that clears it
 * other-computer/signed-in/unpaired/healthy/stale-pairing: names unpaired and the one step that clears it
 * other-computer/signed-in/unpaired/healthy/stale-key: names unpaired and the one step that clears it
 * other-computer/signed-in/revoked/healthy/fresh: names removed and the one step that clears it
 * other-computer/signed-in/revoked/healthy/stale-pairing: names removed and the one step that clears it
 * other-computer/signed-in/revoked/healthy/stale-key: names removed and the one step that clears it
 * phone/signed-out/paired/healthy/fresh: names sign-in and the one step that clears it
 * phone/signed-out/paired/healthy/stale-pairing: names sign-in and the one step that clears it
 * phone/signed-out/paired/healthy/stale-key: names sign-in and the one step that clears it
 * phone/signed-out/unpaired/healthy/fresh: names sign-in and the one step that clears it
 * phone/signed-out/unpaired/healthy/stale-pairing: names sign-in and the one step that clears it
 * phone/signed-out/unpaired/healthy/stale-key: names sign-in and the one step that clears it
 * phone/signed-out/revoked/healthy/fresh: names sign-in and the one step that clears it
 * phone/signed-out/revoked/healthy/stale-pairing: names sign-in and the one step that clears it
 * phone/signed-out/revoked/healthy/stale-key: names sign-in and the one step that clears it
 * phone/signed-in/paired/healthy/fresh: the board within 3 s
 * phone/signed-in/paired/healthy/stale-pairing: the board within 3 s
 * phone/signed-in/paired/healthy/stale-key: names stale-key and the one step that clears it
 * phone/signed-in/unpaired/healthy/fresh: names unpaired and the one step that clears it
 * phone/signed-in/unpaired/healthy/stale-pairing: names unpaired and the one step that clears it
 * phone/signed-in/unpaired/healthy/stale-key: names unpaired and the one step that clears it
 * phone/signed-in/revoked/healthy/fresh: names removed and the one step that clears it
 * phone/signed-in/revoked/healthy/stale-pairing: names removed and the one step that clears it
 * phone/signed-in/revoked/healthy/stale-key: names removed and the one step that clears it
 * board-view/signed-out/paired/oversize/fresh: the board within 3 s
 * board-view/signed-out/paired/oversize/stale-pairing: the board within 3 s
 * board-view/signed-out/paired/oversize/stale-key: the board within 3 s
 * board-view/signed-out/unpaired/oversize/fresh: the board within 3 s
 * board-view/signed-out/unpaired/oversize/stale-pairing: the board within 3 s
 * board-view/signed-out/unpaired/oversize/stale-key: the board within 3 s
 * board-view/signed-out/revoked/oversize/fresh: the board within 3 s
 * board-view/signed-out/revoked/oversize/stale-pairing: the board within 3 s
 * board-view/signed-out/revoked/oversize/stale-key: the board within 3 s
 * board-view/signed-in/paired/oversize/fresh: the board within 3 s
 * board-view/signed-in/paired/oversize/stale-pairing: the board within 3 s
 * board-view/signed-in/paired/oversize/stale-key: the board within 3 s
 * board-view/signed-in/unpaired/oversize/fresh: the board within 3 s
 * board-view/signed-in/unpaired/oversize/stale-pairing: the board within 3 s
 * board-view/signed-in/unpaired/oversize/stale-key: the board within 3 s
 * board-view/signed-in/revoked/oversize/fresh: the board within 3 s
 * board-view/signed-in/revoked/oversize/stale-pairing: the board within 3 s
 * board-view/signed-in/revoked/oversize/stale-key: the board within 3 s
 * board-no-view/signed-out/paired/oversize/fresh: names sign-in and the one step that clears it
 * board-no-view/signed-out/paired/oversize/stale-pairing: names sign-in and the one step that clears it
 * board-no-view/signed-out/paired/oversize/stale-key: names sign-in and the one step that clears it
 * board-no-view/signed-out/unpaired/oversize/fresh: names sign-in and the one step that clears it
 * board-no-view/signed-out/unpaired/oversize/stale-pairing: names sign-in and the one step that clears it
 * board-no-view/signed-out/unpaired/oversize/stale-key: names sign-in and the one step that clears it
 * board-no-view/signed-out/revoked/oversize/fresh: names sign-in and the one step that clears it
 * board-no-view/signed-out/revoked/oversize/stale-pairing: names sign-in and the one step that clears it
 * board-no-view/signed-out/revoked/oversize/stale-key: names sign-in and the one step that clears it
 * board-no-view/signed-in/paired/oversize/fresh: names too-big and the one step that clears it
 * board-no-view/signed-in/paired/oversize/stale-pairing: names too-big and the one step that clears it
 * board-no-view/signed-in/paired/oversize/stale-key: names stale-key and the one step that clears it
 * board-no-view/signed-in/unpaired/oversize/fresh: names unpaired and the one step that clears it
 * board-no-view/signed-in/unpaired/oversize/stale-pairing: names unpaired and the one step that clears it
 * board-no-view/signed-in/unpaired/oversize/stale-key: names unpaired and the one step that clears it
 * board-no-view/signed-in/revoked/oversize/fresh: names removed and the one step that clears it
 * board-no-view/signed-in/revoked/oversize/stale-pairing: names removed and the one step that clears it
 * board-no-view/signed-in/revoked/oversize/stale-key: names removed and the one step that clears it
 * other-computer/signed-out/paired/oversize/fresh: names sign-in and the one step that clears it
 * other-computer/signed-out/paired/oversize/stale-pairing: names sign-in and the one step that clears it
 * other-computer/signed-out/paired/oversize/stale-key: names sign-in and the one step that clears it
 * other-computer/signed-out/unpaired/oversize/fresh: names sign-in and the one step that clears it
 * other-computer/signed-out/unpaired/oversize/stale-pairing: names sign-in and the one step that clears it
 * other-computer/signed-out/unpaired/oversize/stale-key: names sign-in and the one step that clears it
 * other-computer/signed-out/revoked/oversize/fresh: names sign-in and the one step that clears it
 * other-computer/signed-out/revoked/oversize/stale-pairing: names sign-in and the one step that clears it
 * other-computer/signed-out/revoked/oversize/stale-key: names sign-in and the one step that clears it
 * other-computer/signed-in/paired/oversize/fresh: names too-big and the one step that clears it
 * other-computer/signed-in/paired/oversize/stale-pairing: names too-big and the one step that clears it
 * other-computer/signed-in/paired/oversize/stale-key: names stale-key and the one step that clears it
 * other-computer/signed-in/unpaired/oversize/fresh: names unpaired and the one step that clears it
 * other-computer/signed-in/unpaired/oversize/stale-pairing: names unpaired and the one step that clears it
 * other-computer/signed-in/unpaired/oversize/stale-key: names unpaired and the one step that clears it
 * other-computer/signed-in/revoked/oversize/fresh: names removed and the one step that clears it
 * other-computer/signed-in/revoked/oversize/stale-pairing: names removed and the one step that clears it
 * other-computer/signed-in/revoked/oversize/stale-key: names removed and the one step that clears it
 * phone/signed-out/paired/oversize/fresh: names sign-in and the one step that clears it
 * phone/signed-out/paired/oversize/stale-pairing: names sign-in and the one step that clears it
 * phone/signed-out/paired/oversize/stale-key: names sign-in and the one step that clears it
 * phone/signed-out/unpaired/oversize/fresh: names sign-in and the one step that clears it
 * phone/signed-out/unpaired/oversize/stale-pairing: names sign-in and the one step that clears it
 * phone/signed-out/unpaired/oversize/stale-key: names sign-in and the one step that clears it
 * phone/signed-out/revoked/oversize/fresh: names sign-in and the one step that clears it
 * phone/signed-out/revoked/oversize/stale-pairing: names sign-in and the one step that clears it
 * phone/signed-out/revoked/oversize/stale-key: names sign-in and the one step that clears it
 * phone/signed-in/paired/oversize/fresh: names too-big and the one step that clears it
 * phone/signed-in/paired/oversize/stale-pairing: names too-big and the one step that clears it
 * phone/signed-in/paired/oversize/stale-key: names stale-key and the one step that clears it
 * phone/signed-in/unpaired/oversize/fresh: names unpaired and the one step that clears it
 * phone/signed-in/unpaired/oversize/stale-pairing: names unpaired and the one step that clears it
 * phone/signed-in/unpaired/oversize/stale-key: names unpaired and the one step that clears it
 * phone/signed-in/revoked/oversize/fresh: names removed and the one step that clears it
 * phone/signed-in/revoked/oversize/stale-pairing: names removed and the one step that clears it
 * phone/signed-in/revoked/oversize/stale-key: names removed and the one step that clears it
 * board-view/signed-out/paired/approval/fresh: the board within 3 s
 * board-view/signed-out/paired/approval/stale-pairing: the board within 3 s
 * board-view/signed-out/paired/approval/stale-key: the board within 3 s
 * board-view/signed-out/unpaired/approval/fresh: the board within 3 s
 * board-view/signed-out/unpaired/approval/stale-pairing: the board within 3 s
 * board-view/signed-out/unpaired/approval/stale-key: the board within 3 s
 * board-view/signed-out/revoked/approval/fresh: the board within 3 s
 * board-view/signed-out/revoked/approval/stale-pairing: the board within 3 s
 * board-view/signed-out/revoked/approval/stale-key: the board within 3 s
 * board-view/signed-in/paired/approval/fresh: the board within 3 s
 * board-view/signed-in/paired/approval/stale-pairing: the board within 3 s
 * board-view/signed-in/paired/approval/stale-key: the board within 3 s
 * board-view/signed-in/unpaired/approval/fresh: the board within 3 s
 * board-view/signed-in/unpaired/approval/stale-pairing: the board within 3 s
 * board-view/signed-in/unpaired/approval/stale-key: the board within 3 s
 * board-view/signed-in/revoked/approval/fresh: the board within 3 s
 * board-view/signed-in/revoked/approval/stale-pairing: the board within 3 s
 * board-view/signed-in/revoked/approval/stale-key: the board within 3 s
 * board-no-view/signed-out/paired/approval/fresh: names sign-in and the one step that clears it
 * board-no-view/signed-out/paired/approval/stale-pairing: names sign-in and the one step that clears it
 * board-no-view/signed-out/paired/approval/stale-key: names sign-in and the one step that clears it
 * board-no-view/signed-out/unpaired/approval/fresh: names sign-in and the one step that clears it
 * board-no-view/signed-out/unpaired/approval/stale-pairing: names sign-in and the one step that clears it
 * board-no-view/signed-out/unpaired/approval/stale-key: names sign-in and the one step that clears it
 * board-no-view/signed-out/revoked/approval/fresh: names sign-in and the one step that clears it
 * board-no-view/signed-out/revoked/approval/stale-pairing: names sign-in and the one step that clears it
 * board-no-view/signed-out/revoked/approval/stale-key: names sign-in and the one step that clears it
 * board-no-view/signed-in/paired/approval/fresh: the board within 3 s, and names approval
 * board-no-view/signed-in/paired/approval/stale-pairing: the board within 3 s, and names approval
 * board-no-view/signed-in/paired/approval/stale-key: names stale-key and the one step that clears it
 * board-no-view/signed-in/unpaired/approval/fresh: names unpaired and the one step that clears it
 * board-no-view/signed-in/unpaired/approval/stale-pairing: names unpaired and the one step that clears it
 * board-no-view/signed-in/unpaired/approval/stale-key: names unpaired and the one step that clears it
 * board-no-view/signed-in/revoked/approval/fresh: names removed and the one step that clears it
 * board-no-view/signed-in/revoked/approval/stale-pairing: names removed and the one step that clears it
 * board-no-view/signed-in/revoked/approval/stale-key: names removed and the one step that clears it
 * other-computer/signed-out/paired/approval/fresh: names sign-in and the one step that clears it
 * other-computer/signed-out/paired/approval/stale-pairing: names sign-in and the one step that clears it
 * other-computer/signed-out/paired/approval/stale-key: names sign-in and the one step that clears it
 * other-computer/signed-out/unpaired/approval/fresh: names sign-in and the one step that clears it
 * other-computer/signed-out/unpaired/approval/stale-pairing: names sign-in and the one step that clears it
 * other-computer/signed-out/unpaired/approval/stale-key: names sign-in and the one step that clears it
 * other-computer/signed-out/revoked/approval/fresh: names sign-in and the one step that clears it
 * other-computer/signed-out/revoked/approval/stale-pairing: names sign-in and the one step that clears it
 * other-computer/signed-out/revoked/approval/stale-key: names sign-in and the one step that clears it
 * other-computer/signed-in/paired/approval/fresh: the board within 3 s, and names approval
 * other-computer/signed-in/paired/approval/stale-pairing: the board within 3 s, and names approval
 * other-computer/signed-in/paired/approval/stale-key: names stale-key and the one step that clears it
 * other-computer/signed-in/unpaired/approval/fresh: names unpaired and the one step that clears it
 * other-computer/signed-in/unpaired/approval/stale-pairing: names unpaired and the one step that clears it
 * other-computer/signed-in/unpaired/approval/stale-key: names unpaired and the one step that clears it
 * other-computer/signed-in/revoked/approval/fresh: names removed and the one step that clears it
 * other-computer/signed-in/revoked/approval/stale-pairing: names removed and the one step that clears it
 * other-computer/signed-in/revoked/approval/stale-key: names removed and the one step that clears it
 * phone/signed-out/paired/approval/fresh: names sign-in and the one step that clears it
 * phone/signed-out/paired/approval/stale-pairing: names sign-in and the one step that clears it
 * phone/signed-out/paired/approval/stale-key: names sign-in and the one step that clears it
 * phone/signed-out/unpaired/approval/fresh: names sign-in and the one step that clears it
 * phone/signed-out/unpaired/approval/stale-pairing: names sign-in and the one step that clears it
 * phone/signed-out/unpaired/approval/stale-key: names sign-in and the one step that clears it
 * phone/signed-out/revoked/approval/fresh: names sign-in and the one step that clears it
 * phone/signed-out/revoked/approval/stale-pairing: names sign-in and the one step that clears it
 * phone/signed-out/revoked/approval/stale-key: names sign-in and the one step that clears it
 * phone/signed-in/paired/approval/fresh: the board within 3 s, and names approval
 * phone/signed-in/paired/approval/stale-pairing: the board within 3 s, and names approval
 * phone/signed-in/paired/approval/stale-key: names stale-key and the one step that clears it
 * phone/signed-in/unpaired/approval/fresh: names unpaired and the one step that clears it
 * phone/signed-in/unpaired/approval/stale-pairing: names unpaired and the one step that clears it
 * phone/signed-in/unpaired/approval/stale-key: names unpaired and the one step that clears it
 * phone/signed-in/revoked/approval/fresh: names removed and the one step that clears it
 * phone/signed-in/revoked/approval/stale-pairing: names removed and the one step that clears it
 * phone/signed-in/revoked/approval/stale-key: names removed and the one step that clears it
 * board-view/signed-out/paired/mixed/fresh: the board within 3 s
 * board-view/signed-out/paired/mixed/stale-pairing: the board within 3 s
 * board-view/signed-out/paired/mixed/stale-key: the board within 3 s
 * board-view/signed-out/unpaired/mixed/fresh: the board within 3 s
 * board-view/signed-out/unpaired/mixed/stale-pairing: the board within 3 s
 * board-view/signed-out/unpaired/mixed/stale-key: the board within 3 s
 * board-view/signed-out/revoked/mixed/fresh: the board within 3 s
 * board-view/signed-out/revoked/mixed/stale-pairing: the board within 3 s
 * board-view/signed-out/revoked/mixed/stale-key: the board within 3 s
 * board-view/signed-in/paired/mixed/fresh: the board within 3 s
 * board-view/signed-in/paired/mixed/stale-pairing: the board within 3 s
 * board-view/signed-in/paired/mixed/stale-key: the board within 3 s
 * board-view/signed-in/unpaired/mixed/fresh: the board within 3 s
 * board-view/signed-in/unpaired/mixed/stale-pairing: the board within 3 s
 * board-view/signed-in/unpaired/mixed/stale-key: the board within 3 s
 * board-view/signed-in/revoked/mixed/fresh: the board within 3 s
 * board-view/signed-in/revoked/mixed/stale-pairing: the board within 3 s
 * board-view/signed-in/revoked/mixed/stale-key: the board within 3 s
 * board-no-view/signed-out/paired/mixed/fresh: names sign-in and the one step that clears it
 * board-no-view/signed-out/paired/mixed/stale-pairing: names sign-in and the one step that clears it
 * board-no-view/signed-out/paired/mixed/stale-key: names sign-in and the one step that clears it
 * board-no-view/signed-out/unpaired/mixed/fresh: names sign-in and the one step that clears it
 * board-no-view/signed-out/unpaired/mixed/stale-pairing: names sign-in and the one step that clears it
 * board-no-view/signed-out/unpaired/mixed/stale-key: names sign-in and the one step that clears it
 * board-no-view/signed-out/revoked/mixed/fresh: names sign-in and the one step that clears it
 * board-no-view/signed-out/revoked/mixed/stale-pairing: names sign-in and the one step that clears it
 * board-no-view/signed-out/revoked/mixed/stale-key: names sign-in and the one step that clears it
 * board-no-view/signed-in/paired/mixed/fresh: the board within 3 s, and names too-big
 * board-no-view/signed-in/paired/mixed/stale-pairing: the board within 3 s, and names too-big
 * board-no-view/signed-in/paired/mixed/stale-key: names stale-key and the one step that clears it
 * board-no-view/signed-in/unpaired/mixed/fresh: names unpaired and the one step that clears it
 * board-no-view/signed-in/unpaired/mixed/stale-pairing: names unpaired and the one step that clears it
 * board-no-view/signed-in/unpaired/mixed/stale-key: names unpaired and the one step that clears it
 * board-no-view/signed-in/revoked/mixed/fresh: names removed and the one step that clears it
 * board-no-view/signed-in/revoked/mixed/stale-pairing: names removed and the one step that clears it
 * board-no-view/signed-in/revoked/mixed/stale-key: names removed and the one step that clears it
 * other-computer/signed-out/paired/mixed/fresh: names sign-in and the one step that clears it
 * other-computer/signed-out/paired/mixed/stale-pairing: names sign-in and the one step that clears it
 * other-computer/signed-out/paired/mixed/stale-key: names sign-in and the one step that clears it
 * other-computer/signed-out/unpaired/mixed/fresh: names sign-in and the one step that clears it
 * other-computer/signed-out/unpaired/mixed/stale-pairing: names sign-in and the one step that clears it
 * other-computer/signed-out/unpaired/mixed/stale-key: names sign-in and the one step that clears it
 * other-computer/signed-out/revoked/mixed/fresh: names sign-in and the one step that clears it
 * other-computer/signed-out/revoked/mixed/stale-pairing: names sign-in and the one step that clears it
 * other-computer/signed-out/revoked/mixed/stale-key: names sign-in and the one step that clears it
 * other-computer/signed-in/paired/mixed/fresh: the board within 3 s, and names too-big
 * other-computer/signed-in/paired/mixed/stale-pairing: the board within 3 s, and names too-big
 * other-computer/signed-in/paired/mixed/stale-key: names stale-key and the one step that clears it
 * other-computer/signed-in/unpaired/mixed/fresh: names unpaired and the one step that clears it
 * other-computer/signed-in/unpaired/mixed/stale-pairing: names unpaired and the one step that clears it
 * other-computer/signed-in/unpaired/mixed/stale-key: names unpaired and the one step that clears it
 * other-computer/signed-in/revoked/mixed/fresh: names removed and the one step that clears it
 * other-computer/signed-in/revoked/mixed/stale-pairing: names removed and the one step that clears it
 * other-computer/signed-in/revoked/mixed/stale-key: names removed and the one step that clears it
 * phone/signed-out/paired/mixed/fresh: names sign-in and the one step that clears it
 * phone/signed-out/paired/mixed/stale-pairing: names sign-in and the one step that clears it
 * phone/signed-out/paired/mixed/stale-key: names sign-in and the one step that clears it
 * phone/signed-out/unpaired/mixed/fresh: names sign-in and the one step that clears it
 * phone/signed-out/unpaired/mixed/stale-pairing: names sign-in and the one step that clears it
 * phone/signed-out/unpaired/mixed/stale-key: names sign-in and the one step that clears it
 * phone/signed-out/revoked/mixed/fresh: names sign-in and the one step that clears it
 * phone/signed-out/revoked/mixed/stale-pairing: names sign-in and the one step that clears it
 * phone/signed-out/revoked/mixed/stale-key: names sign-in and the one step that clears it
 * phone/signed-in/paired/mixed/fresh: the board within 3 s, and names too-big
 * phone/signed-in/paired/mixed/stale-pairing: the board within 3 s, and names too-big
 * phone/signed-in/paired/mixed/stale-key: names stale-key and the one step that clears it
 * phone/signed-in/unpaired/mixed/fresh: names unpaired and the one step that clears it
 * phone/signed-in/unpaired/mixed/stale-pairing: names unpaired and the one step that clears it
 * phone/signed-in/unpaired/mixed/stale-key: names unpaired and the one step that clears it
 * phone/signed-in/revoked/mixed/fresh: names removed and the one step that clears it
 * phone/signed-in/revoked/mixed/stale-pairing: names removed and the one step that clears it
 * phone/signed-in/revoked/mixed/stale-key: names removed and the one step that clears it
 * CELLS-END
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { relayClientFixture } from '../../../tests/fixtures/relay/client.js';
import { enrollProtocolPhone } from '../../../tests/fixtures/relay/enrollment.js';
import { hostedEngines } from '../../../tests/fixtures/hosted/browsers.js';
import { openEngine } from '../../../tests/fixtures/hosted/browsers.js';
import {
  BOARD_ITEM,
  BOARDS,
  HOSTED,
  OPEN_BOARD,
  READ_SCREEN,
  STORED,
  boardView,
  cells,
  enrolledDevices,
  expected,
  freshSession,
  headerLine,
  hostedFront,
  impossibility,
  judge,
  relayOnAll,
  relayPairClears,
  revokeDevice,
  siblingProject,
  storedScript,
  visit,
} from '../../../tests/fixtures/hosted/shapes.js';

/**
 * Each failing cell's cause: one filed defect per cause, listing every cell it covers as engine:cell. A fix removes
 * its cause, and the matrix then requires those cells to pass; a listed cell that passes fails the run, so the lists
 * stay true.
 */
/** Exact 72 revoked keys retained from the committed #981 cause, independent of later defect removal. */
const REVOKED_981_CELLS = [
      'chromium:board-no-view/signed-in/revoked/approval/fresh',
      'chromium:board-no-view/signed-in/revoked/approval/stale-key',
      'chromium:board-no-view/signed-in/revoked/approval/stale-pairing',
      'chromium:board-no-view/signed-in/revoked/healthy/fresh',
      'chromium:board-no-view/signed-in/revoked/healthy/stale-key',
      'chromium:board-no-view/signed-in/revoked/healthy/stale-pairing',
      'chromium:board-no-view/signed-in/revoked/mixed/fresh',
      'chromium:board-no-view/signed-in/revoked/mixed/stale-key',
      'chromium:board-no-view/signed-in/revoked/mixed/stale-pairing',
      'chromium:board-no-view/signed-in/revoked/oversize/fresh',
      'chromium:board-no-view/signed-in/revoked/oversize/stale-key',
      'chromium:board-no-view/signed-in/revoked/oversize/stale-pairing',
      'chromium:other-computer/signed-in/revoked/approval/fresh',
      'chromium:other-computer/signed-in/revoked/approval/stale-key',
      'chromium:other-computer/signed-in/revoked/approval/stale-pairing',
      'chromium:other-computer/signed-in/revoked/healthy/fresh',
      'chromium:other-computer/signed-in/revoked/healthy/stale-key',
      'chromium:other-computer/signed-in/revoked/healthy/stale-pairing',
      'chromium:other-computer/signed-in/revoked/mixed/fresh',
      'chromium:other-computer/signed-in/revoked/mixed/stale-key',
      'chromium:other-computer/signed-in/revoked/mixed/stale-pairing',
      'chromium:other-computer/signed-in/revoked/oversize/fresh',
      'chromium:other-computer/signed-in/revoked/oversize/stale-key',
      'chromium:other-computer/signed-in/revoked/oversize/stale-pairing',
      'chromium:phone/signed-in/revoked/approval/fresh',
      'chromium:phone/signed-in/revoked/approval/stale-key',
      'chromium:phone/signed-in/revoked/approval/stale-pairing',
      'chromium:phone/signed-in/revoked/healthy/fresh',
      'chromium:phone/signed-in/revoked/healthy/stale-key',
      'chromium:phone/signed-in/revoked/healthy/stale-pairing',
      'chromium:phone/signed-in/revoked/mixed/fresh',
      'chromium:phone/signed-in/revoked/mixed/stale-key',
      'chromium:phone/signed-in/revoked/mixed/stale-pairing',
      'chromium:phone/signed-in/revoked/oversize/fresh',
      'chromium:phone/signed-in/revoked/oversize/stale-key',
      'chromium:phone/signed-in/revoked/oversize/stale-pairing',
      'webkit:board-no-view/signed-in/revoked/approval/fresh',
      'webkit:board-no-view/signed-in/revoked/approval/stale-key',
      'webkit:board-no-view/signed-in/revoked/approval/stale-pairing',
      'webkit:board-no-view/signed-in/revoked/healthy/fresh',
      'webkit:board-no-view/signed-in/revoked/healthy/stale-key',
      'webkit:board-no-view/signed-in/revoked/healthy/stale-pairing',
      'webkit:board-no-view/signed-in/revoked/mixed/fresh',
      'webkit:board-no-view/signed-in/revoked/mixed/stale-key',
      'webkit:board-no-view/signed-in/revoked/mixed/stale-pairing',
      'webkit:board-no-view/signed-in/revoked/oversize/fresh',
      'webkit:board-no-view/signed-in/revoked/oversize/stale-key',
      'webkit:board-no-view/signed-in/revoked/oversize/stale-pairing',
      'webkit:other-computer/signed-in/revoked/approval/fresh',
      'webkit:other-computer/signed-in/revoked/approval/stale-key',
      'webkit:other-computer/signed-in/revoked/approval/stale-pairing',
      'webkit:other-computer/signed-in/revoked/healthy/fresh',
      'webkit:other-computer/signed-in/revoked/healthy/stale-key',
      'webkit:other-computer/signed-in/revoked/healthy/stale-pairing',
      'webkit:other-computer/signed-in/revoked/mixed/fresh',
      'webkit:other-computer/signed-in/revoked/mixed/stale-key',
      'webkit:other-computer/signed-in/revoked/mixed/stale-pairing',
      'webkit:other-computer/signed-in/revoked/oversize/fresh',
      'webkit:other-computer/signed-in/revoked/oversize/stale-key',
      'webkit:other-computer/signed-in/revoked/oversize/stale-pairing',
      'webkit:phone/signed-in/revoked/approval/fresh',
      'webkit:phone/signed-in/revoked/approval/stale-key',
      'webkit:phone/signed-in/revoked/approval/stale-pairing',
      'webkit:phone/signed-in/revoked/healthy/fresh',
      'webkit:phone/signed-in/revoked/healthy/stale-key',
      'webkit:phone/signed-in/revoked/healthy/stale-pairing',
      'webkit:phone/signed-in/revoked/mixed/fresh',
      'webkit:phone/signed-in/revoked/mixed/stale-key',
      'webkit:phone/signed-in/revoked/mixed/stale-pairing',
      'webkit:phone/signed-in/revoked/oversize/fresh',
      'webkit:phone/signed-in/revoked/oversize/stale-key',
      'webkit:phone/signed-in/revoked/oversize/stale-pairing',
    ];

// All five remaining causes have independently landed: #976 (0a1297b3), #978 (2255282c),
// #982 (04ad3ccc), #983 (fca4f3ff), and #984 (fcf180f2). Their cells must now pass;
// an empty list grants no exceptions to the ordinary judge or its original timing and privacy guards.
const CAUSES = [];

/** The filed defect that covers one failing cell, or undefined. */
function causeOf(key) {
  return CAUSES.find((cause) => cause.cells.includes(key));
}

/**
 * The matrix takes many minutes, so it runs as its own job (hosted-shapes in .github/workflows/gate.yml), never in
 * the landing gate or a submit's affected tests: only with this variable set.
 */
const OWN_JOB = process.env.PULLBOARD_HOSTED_SHAPES === '1';
/** Explicit scoped acceptance, independent of the full matrix and ordinary cross-platform test cadence. */
const REVOKED_PROOF = process.env.PULLBOARD_REVOKED_PROOF === '1';

/** How many unpaired cells one engine runs at once; each is its own browser context. */
const PARALLEL = 4;

/** The board ids and keys a linked project holds on this computer. */
function linkOf(box, root) {
  const state = JSON.parse(readFileSync(join(root, '.git', 'pullboard', 'relay.json'), 'utf8'));
  return { id: state.board, key: readFileSync(join(box.env.PULLBOARD_HOME, 'relay-keys', state.board + '.key'), 'utf8').trim() };
}

/**
 * Build one board state as a person would reach it, on its own relay account, and enroll then revoke one browser
 * per engine on the way, so the revoked identities are real.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} boards
 * @param {{ name: string, context: object }[]} revokedIdentities - one browser context per engine, to be revoked
 * @param {object} front - the hosted front for this relay, created by the caller once the relay exists
 */
async function buildBoards(t, boards, engines) {
  const box = await relayClientFixture(t);
  box.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_HOME;
  const front = await hostedFront(box.origin);
  t.after(() => front.close());
  const revoked = {};
  const linked = [];
  /** Enroll this engine's revoked identity through the real relay on --all, then revoke it with relay revoke. */
  const enrollAndRevoke = async () => {
    for (const engine of engines) {
      const context = await engine.newContext();
      const session = await freshSession(box);
      let page;
      try {
        await relayOnAll(box, async (link) => {
          page = await context.newPage({ route: front.route(session, null) });
          await page.navigate(link);
        });
      } catch (error) {
        const seen = page ? await page.evaluate(READ_SCREEN).catch(() => null) : null;
        error.message += ` (enrolling ${engine.name}; its page showed ${JSON.stringify(seen)})`;
        throw error;
      }
      // relay on --all returns only once this browser enrolled and received its board keys.
      await page.close();
      const [device] = enrolledDevices(box);
      await revokeDevice(box, device);
      revoked[engine.name] = { context, session };
    }
  };
  if (boards === 'excluded') {
    assert.equal((await box.cli('relay', 'off')).code, 0, 'relay off excludes the board');
    await relayOnAll(box);
  }
  if (boards === 'healthy') { await enrollAndRevoke(); linked.push(linkOf(box, box.root)); }
  if (boards === 'oversize') {
    box.legacySnapshotApi('bad-route');
    box.rejectSnapshots({ status: 400, code: 'BAD_REQUEST', message: 'the body exceeds 14000000 bytes; send a smaller snapshot' });
    await enrollAndRevoke();
    linked.push(linkOf(box, box.root));
  }
  if (boards === 'approval') {
    await enrollAndRevoke();
    linked.push(linkOf(box, box.root));
    // The owner's own phone holds the approval card; the browsers under test are other browsers.
    await enrollProtocolPhone(box);
    const waiting = await siblingProject(box, 'notes', 'fixture/notes');
    const machine = JSON.parse(readFileSync(join(box.env.PULLBOARD_HOME, 'relay-machine/state.json'), 'utf8'));
    assert.ok(machine.approvals.some((entry) => entry.root === waiting && entry.published), 'the new project waits for a phone approval');
  }
  if (boards === 'mixed') {
    const big = await siblingProject(box, 'big', 'fixture/big');
    const skipped = await siblingProject(box, 'skipped', 'fixture/skipped');
    assert.equal((await box.cliAt(skipped, 'relay', 'off')).code, 0, 'one project is excluded');
    await enrollAndRevoke();
    box.legacySnapshotApi('bad-route');
    box.rejectSnapshots({ status: 400, code: 'BAD_REQUEST', message: 'the body exceeds 14000000 bytes; send a smaller snapshot' });
    assert.equal((await box.cliAt(big, 'relay', 'on', '--url', box.origin)).code, 0, 'the big project links, paused for size');
    linked.push(linkOf(box, box.root), linkOf(box, big));
  }
  const view = await boardView(box);
  t.after(() => view.stop());
  return { box, front, view, revoked, linked, unpairedSession: await freshSession(box), pairedSession: await freshSession(box) };
}

/** Run every cell of one board state in one engine; returns the failures as cell id -> reason, with timings. */
async function runCells(engine, built, boardCells, report, ineffective) {
  const { front, view, revoked, linked } = built;
  const keys = Object.fromEntries(linked.map(({ id, key }) => [id, key]));
  const boardIds = linked.map(({ id }) => id);
  const failures = {};
  /** Visit one cell in the given identity's context. */
  const one = async (cell, context, session) => {
    const want = expected(cell);
    const browser = impossibility(cell)?.runsAs.browser ?? cell.browser;
    const bootstrap = storedScript(cell.stored, { keys: browser === 'paired' ? keys : null, boards: boardIds });
    const route = front.route(cell.account === 'signed-in' ? session : null, cell.where === 'board-view' ? view.base : null);
    let seen;
    try { seen = await visit(context, { route, phone: cell.where === 'phone', bootstrap,
      localView: cell.where === 'board-view' ? built.view.base + '/local/view' : null }, want.board); }
    catch (error) { seen = { board: false, approval: false, words: 'visit failed: ' + error.message, commands: [], signIn: false, ms: null,
      capture: error.pageState ?? { unavailable: true, error: error.message } }; }
    let problem = judge(cell, seen, ineffective);
    // A board that arrived but over the bar is measured once more: one slow sample on a loaded machine is noise, two
    // are a finding. Both timings are reported.
    // A board still loading at the ceiling (a blank or 'Finding your boards' screen) is likewise measured once more.
    if (problem?.startsWith('the board took') || problem?.startsWith('the board did not show') && (!seen.words || /finding your boards|checking your/iu.test(seen.words))) {
      const again = await visit(context, { route, phone: cell.where === 'phone', bootstrap }, want.board).catch(() => null);
      if (again) { seen = { ...again, words: again.words, firstMs: seen.ms, firstCapture: seen.capture }; problem = judge(cell, seen, ineffective); }
    }
    const failure = problem ? problem + '\nPAGE_STATE=' + JSON.stringify(seen.capture ?? { unavailable: true }) : null;
    report.push({ engine: engine.name, cell: cell.id, ok: !problem, problem: failure, ms: seen.ms, firstMs: seen.firstMs ?? null,
      words: seen.words.slice(0, 300), commands: seen.commands, pageState: seen.capture ?? null, firstPageState: seen.firstCapture ?? null });
    if (problem) failures[cell.id] = failure;
  };
  const unpaired = boardCells.filter((cell) => (impossibility(cell)?.runsAs.browser ?? cell.browser) === 'unpaired');
  for (let at = 0; at < unpaired.length; at += PARALLEL) {
    await Promise.all(unpaired.slice(at, at + PARALLEL).map(async (cell) => {
      const context = await engine.newContext();
      try { await one(cell, context, built.unpairedSession); } finally { await context.close(); }
    }));
  }
  // A paired browser keeps its keys in its own storage, so each stored state gets its own paired context, and the
  // cells within one run in turn; the revoked browser is the one enrolled browser, so its cells run in turn too.
  const pairedCells = boardCells.filter((entry) => !impossibility(entry) && entry.browser === 'paired');
  const revokedRun = (async () => {
    for (const cell of boardCells.filter((entry) => !impossibility(entry) && entry.browser === 'revoked')) {
      await one(cell, revoked[engine.name].context, revoked[engine.name].session);
    }
  })();
  await Promise.all(STORED.map(async (stored) => {
    const paired = await engine.newContext();
    try { for (const cell of pairedCells.filter((entry) => entry.stored === stored)) await one(cell, paired, built.pairedSession); }
    finally { await paired.close(); }
  }));
  await revokedRun;
  return failures;
}

test('a forced hosted cell failure captures its final page state without raising its budget [H5,H17,N26]', async t => {
  assert.ok(hostedEngines().find(engine => engine.name === 'chromium')?.available, 'real Chrome is required');
  const engine = await openEngine('chromium');
  t.after(() => engine.close());
  const built = await buildBoards(t, 'approval', [engine]);
  t.after(async () => {
    for (const identity of Object.values(built.revoked)) await identity.context.close();
  });
  const cell = cells().find(entry => entry.id === 'board-view/signed-in/paired/approval/fresh');
  assert.ok(cell, 'the control selects one actual committed matrix cell');
  const beforeFault = [];
  // Only this control's fresh contexts remove the chain, after witnessing the genuine seeded board.
  const forced = {
    name: engine.name,
    /** Open a real fresh context; only this control's page navigation adds a display fault. */
    async newContext() {
      const context = await engine.newContext();
      const open = context.newPage.bind(context);
      return {
        ...context,
        /** Keep the actual browser page, witness the board, then remove its owned display node. */
        async newPage(options) {
          const page = await open(options);
          return {
            ...page,
            /** Navigate normally and remove only the already witnessed item-chain node. */
            async navigate(url) {
              await page.navigate(url);
              const shown = await page.poll(OPEN_BOARD, 8_000); // budget: existing blocker-settle fixture ceiling, not a speed assertion.
              assert.ok(shown, 'the real seeded board appears before this control injects its fault');
              beforeFault.push(await page.evaluate(READ_SCREEN));
              await page.evaluate(`document.querySelector('#chain').remove()`);
            },
          };
        },
      };
    },
  };
  const report = [];
  const failures = await runCells(forced, built, [cell], report, []);
  assert.deepEqual(Object.keys(failures), [cell.id], 'exactly the selected cell genuinely fails');
  assert.match(failures[cell.id], /the board did not show within 3000 ms/u, 'the original cell judge still owns the failure');
  assert.equal(report.length, 1, 'the control does not run another matrix cell');
  assert.ok(beforeFault.length > 0 && beforeFault.every(seen => seen.board), 'every injected fault follows the actual seeded-board positive witness');
  assert.match(failures[cell.id], /PAGE_STATE=/u, 'the actual matrix failure message carries the final page capture');
  const state = JSON.parse(failures[cell.id].split('PAGE_STATE=')[1]);
  assert.equal(state.budgetMs, 3000, 'capture never raises the board budget');
  assert.ok(state.elapsedMs >= state.budgetMs, 'the real forced visit reached the unchanged budget');
  assert.equal(typeof state.screen, 'string');
  assert.equal(typeof state.busy, 'boolean');
  assert.equal(state.chain.present, false, 'capture observes the owned control removing the chain');
  assert.equal(state.chain.visible, false, 'the removed chain cannot count as visible');
  assert.equal(state.chain.hasExpectedItem, false, 'the positive witness was removed rather than replaced with another board');
  assert.equal(typeof state.noBoardsYet.visible, 'boolean');
  assert.match(state.noBoardsYet.text, /No boards yet/u, 'capture records the empty-state text even when hidden');
});

test('a board over the size limit is named with its size and the limit, beside a healthy board too [H5,H17]', {
  timeout: 180_000, // budget: real enrollment, refused upload, healthy sibling and bounded-snapshot recovery.
}, async t => {
  assert.ok(hostedEngines().find(engine => engine.name === 'chromium')?.available, 'real Chrome is required');
  const engine = await openEngine('chromium');
  const contexts = [];
  t.after(async () => {
    for (const context of contexts) await context.close();
    await engine.close();
  });
  const box = await relayClientFixture(t);
  box.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_HOME;
  box.legacySnapshotApi(true);
  box.limitSnapshots(128);
  const front = await hostedFront(box.origin);
  t.after(() => front.close());
  const paired = await engine.newContext();
  contexts.push(paired);
  const session = await freshSession(box);
  let page;
  await relayOnAll(box, async link => {
    page = await paired.newPage({ route: front.route(session, null) });
    await page.navigate(link);
  });
  await page.close();
  const link = linkOf(box, box.root);
  const refusal = box.sizeRefusals().find(value => value.board === link.id);
  assert.ok(refusal && refusal.sealedBytes > refusal.limit, 'the configured relay refused an actually oversized upload');
  const local = JSON.parse(readFileSync(join(box.root, '.git', 'pullboard', 'relay.json'), 'utf8'));
  assert.equal(local.baselinePause.status, 400, 'the native command received the permanent upload refusal');
  assert.equal(Buffer.from(local.snapshot.sealed, 'base64url').byteLength, refusal.sealedBytes,
    'the retained snapshot is exactly the upload measured by the relay');
  const alone = await visit(paired, { route: front.route(session, null), phone: true }, false);
  assert.match(alone.words, /fixture\/repository[^.]*too (?:big|large)/iu, 'name the size blocker rather than a missing first copy');
  assert.ok(alone.words.includes(refusal.sealedBytes + ' bytes'), 'show the measured sealed size');
  assert.ok(alone.words.includes(refusal.limit + ' bytes'), 'show the limit reported by this relay');
  assert.match(alone.words, /upgrade[^.]*relay[^.]*bounded snapshots/iu, 'offer the step that removes the actual limit');

  box.limitSnapshots(null);
  const healthy = await siblingProject(box, 'healthy-sibling', 'fixture/healthy-sibling');
  const healthyLane = Object.keys(JSON.parse(readFileSync(join(healthy, 'pullboard.json'), 'utf8')).lanes)[0];
  assert.equal((await box.cliAt(healthy, 'add', healthyLane, BOARD_ITEM)).code, 0,
    'the healthy board has the real item required by the unchanged visibility probe');
  assert.equal((await box.cliAt(healthy, 'relay', 'on', '--url', box.origin)).code, 0);
  const mixed = await visit(paired, { route: front.route(session, null), phone: true }, true);
  assert.equal(mixed.board, true, 'the healthy sibling remains readable');
  assert.match(mixed.words, /fixture\/repository[^.]*too (?:big|large)/iu, 'keep the size blocker beside the healthy board');
  assert.ok(mixed.words.includes(refusal.sealedBytes + ' bytes') && mixed.words.includes(refusal.limit + ' bytes'));
  box.legacySnapshotApi(false);
  assert.equal((await box.cli('status')).code, 0, 'the offered bounded-snapshot upgrade actually resumes publication');
  const recovered = await visit(paired, { route: front.route(session, null), phone: true }, true);
  assert.equal(recovered.board, true);
  assert.doesNotMatch(recovered.words, /too (?:big|large)|128 bytes/iu, 'a successful snapshot clears its stale size notice');
});

test('an excluded board is named as excluded with the step that includes it [H5,H17]', {
  timeout: 180_000, // budget: two real relay setups, one native enrollment and fresh browser visits.
}, async t => {
  assert.ok(hostedEngines().find(engine => engine.name === 'chromium')?.available, 'real Chrome is required');
  const engine = await openEngine('chromium');
  const contexts = [];
  t.after(async () => {
    // Dispose targets while CDP is live, before shutting down the shared browser.
    for (const context of contexts) await context.close();
    await engine.close();
  });
  const built = await buildBoards(t, 'excluded', [engine]);
  const fresh = await engine.newContext();
  contexts.push(fresh);
  const unpaired = await visit(fresh, {
    route: built.front.route(built.unpairedSession, null), phone: true,
    bootstrap: storedScript('fresh', { boards: [] }),
  }, false);
  assert.equal(unpaired.board, false, 'exclusion never links or discloses the board');
  assert.match(unpaired.words, /1 board excluded/iu, 'a fresh browser sees the actual exclusion count');
  assert.doesNotMatch(unpaired.words, /fixture\/repository/u, 'a browser without a device wrap sees no excluded name');
  assert.ok(unpaired.commands.some(command => /pullboard relay on(?:\s|$)/u.test(command)
    && !/--all/u.test(command)), 'the command includes a board that the completed --all skipped');
  assert.equal(unpaired.commands.some(command => /pullboard relay on --all/u.test(command)), false);

  const box = await relayClientFixture(t);
  box.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_HOME;
  const front = await hostedFront(box.origin);
  t.after(() => front.close());
  const paired = await engine.newContext();
  contexts.push(paired);
  const session = await freshSession(box);
  let pairingPage;
  await relayOnAll(box, async link => {
    pairingPage = await paired.newPage({ route: front.route(session, null) });
    await pairingPage.navigate(link);
  });
  assert.ok(await pairingPage.poll(OPEN_BOARD, 8_000), 'the genuine enrolled browser opens the healthy board');
  await pairingPage.close();
  const excluded = await siblingProject(box, 'excluded-project', 'fixture/excluded-board');
  assert.equal((await box.cliAt(excluded, 'relay', 'off')).code, 0);
  const metadata = await fetch(box.origin + '/api/v1/devices/exclusions', { headers: { cookie: 'pb_session=' + session } });
  assert.equal(metadata.status, 200);
  const publicInventory = await metadata.json();
  assert.equal(publicInventory.exclusions.length, 1);
  assert.equal(publicInventory.exclusions[0].count, 1);
  assert.ok(publicInventory.exclusions[0].label.trim(), 'only a bounded machine label is public');
  assert.doesNotMatch(JSON.stringify(publicInventory), /fixture\/excluded-board|excluded-project/u,
    'the relay public inventory contains neither repository names nor local paths');
  const unwrapped = await visit(fresh, { route: front.route(session, null), phone: true }, false);
  assert.doesNotMatch(unwrapped.words, /fixture\/excluded-board/u,
    'an existing phone-approval notice cannot disclose an excluded name to an unwrapped browser');
  const named = await visit(paired, { route: front.route(session, null), phone: true }, true);
  assert.equal(named.board, true, 'the healthy board remains readable beside the exclusion');
  assert.match(named.words, /fixture\/excluded-board[^.]*excluded/iu, 'only the device-wrapped browser decrypts the excluded name');
  assert.match(named.words, /pullboard relay on/u, 'the named exclusion carries its include command');
  assert.equal((await box.cliAt(excluded, 'relay', 'on', '--url', box.origin)).code, 0,
    'the offered ordinary command actually includes the excluded board');
  const cleared = await fetch(box.origin + '/api/v1/devices/exclusions', { headers: { cookie: 'pb_session=' + session } });
  assert.equal(cleared.status, 200);
  assert.deepEqual((await cleared.json()).exclusions, [], 'including the board clears its published exclusion');
  assert.equal((await box.cliAt(excluded, 'relay', 'off')).code, 0,
    'off also publishes from the removed board’s own machine credential');
  const removed = await fetch(box.origin + '/api/v1/devices/exclusions', { headers: { cookie: 'pb_session=' + session } });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).exclusions[0]?.count, 1, 'a linked board’s removal publishes without setup or its forgotten board key');
});

test('a board awaiting a phone approval is mentioned on a non-phone paired browser [H5]', {
  timeout: 180_000,
}, async (t) => {
  if (!hostedEngines().some((engine) => engine.name === 'chromium' && engine.available)) return t.skip('Chrome is not installed; set PULLBOARD_CHROME');
  const engine = await openEngine('chromium');
  t.after(() => engine.close());
  const built = await buildBoards(t, 'approval', [engine]);
  const keys = Object.fromEntries(built.linked.map(({ id, key }) => [id, key]));
  const boards = built.linked.map(({ id }) => id);
  const context = await engine.newContext();
  t.after(() => context.close());
  const seen = await visit(context, {
    route: built.front.route(built.pairedSession, null), phone: false,
    bootstrap: storedScript('fresh', { keys, boards }),
  }, true);
  assert.equal(judge({ where: 'other-computer', account: 'signed-in', browser: 'paired', boards: 'approval', stored: 'fresh' }, seen), null, seen.words);
});

test('every listed cause is a filed item covering real cells, each cell once [H5,C7]', () => {
  const all = new Set(cells().flatMap((cell) => ['chromium', 'webkit'].map((engine) => `${engine}:${cell.id}`)));
  const seen = new Set();
  for (const cause of CAUSES) {
    assert.ok(Number.isSafeInteger(cause.item) && cause.item > 0 && cause.cause, 'each cause names its filed item and why');
    for (const key of cause.cells) {
      assert.ok(all.has(key), `${key} is a cell of the matrix`);
      assert.equal(seen.has(key), false, `${key} has one cause`);
      seen.add(key);
    }
  }
});

test('the header lists every cell and the screen it must reach [H5,H17,N26]', () => {
  const source = readFileSync(new URL(import.meta.url), 'utf8');
  const listed = source.slice(source.indexOf(' * CELLS-START\n') + ' * CELLS-START\n'.length, source.indexOf(' * CELLS-END'));
  assert.equal(cells().length, 4 * 2 * 3 * 6 * 3, 'the matrix is every combination');
  assert.equal(listed, cells().map(headerLine).join('\n') + '\n', 'the header lists every cell with its screen; regenerate it from headerLine when the matrix changes');
});

test('the matrix runs as its own job, outside the landing gate [H5,C7]', () => {
  const workflow = readFileSync(new URL('../../../../../.github/workflows/gate.yml', import.meta.url), 'utf8');
  const job = workflow.match(/\n  hosted-shapes:\n([\s\S]*?)\n  [a-z-]+:\n/u)?.[1];
  assert.ok(job, 'gate.yml has a hosted-shapes job beside the gate’s test jobs');
  assert.match(job, /if: github\.ref == 'refs\/heads\/main' && github\.event_name != 'pull_request'/u);
  assert.match(job, /run: npm run hosted-shapes/u);
  assert.equal(workflow.match(/npm run hosted-shapes|PULLBOARD_HOSTED_SHAPES|hosted-shapes\.test\.js/gu).length, 1, 'no other job runs the matrix');
  const scripts = JSON.parse(readFileSync(new URL('../../../../../package.json', import.meta.url), 'utf8')).scripts;
  assert.equal(scripts['hosted-shapes'], 'PULLBOARD_HOSTED_SHAPES=1 node apps/cli/src/io/run/tests.js apps/cli/journeys/relay/hosted/shapes.test.js', 'one script runs the matrix as its own job');
  assert.equal(/hosted-shapes|PULLBOARD_HOSTED_SHAPES/u.test(scripts.gate + scripts.test), false, 'the gate and npm test never set it');
});

for (const boards of BOARDS) {
  test(`every shape opens or names its blocker: ${boards} [H5,H17,N26]`, {
    timeout: 900_000, // budget: hang ceiling for one board state's setup and both engines' cells.
    skip: !OWN_JOB && 'the matrix runs as its own job: set PULLBOARD_HOSTED_SHAPES=1, as the hosted-shapes job does',
  }, async (t) => {
    const available = hostedEngines().filter((engine) => engine.available);
    for (const engine of hostedEngines().filter((entry) => !entry.available)) t.diagnostic(`${engine.name} column skipped: ${engine.reason}`);
    if (!available.length) return t.skip('no browser on this machine');
    const engines = [];
    for (const { name } of available) engines.push(await openEngine(name));
    t.after(async () => { for (const engine of engines) await engine.close(); });
    const started = Date.now();
    const built = await buildBoards(t, boards, engines);
    t.diagnostic(`${boards}: setup ${Date.now() - started} ms`);
    const boardCells = cells().filter((cell) => cell.boards === boards);
    // The pairing step the page offers an unpaired browser, run once for real in the first engine: pairing is the
    // CLI's and the relay's, not the browser's. If it does not open the board, offering it does not clear the blocker.
    const clears = built.linked.length ? await relayPairClears(built.box, engines[0], built.front, built.unpairedSession) : null;
    t.diagnostic(`${boards}: pullboard relay pair ${clears === null ? 'not offered' : clears ? 'opens the board' : 'does not open the board'}`);
    const ineffective = clears === false ? ['pullboard relay pair'] : [];
    const report = [];
    const unexpected = [];
    // The engines run side by side: separate browsers and contexts, one relay and one view.
    const results = await Promise.all(engines.map(async (engine) => {
      const ran = Date.now();
      const failures = await runCells(engine, built, boardCells, report, ineffective);
      t.diagnostic(`${boards} ${engine.name}: ${boardCells.length} cells in ${Date.now() - ran} ms, ${Object.keys(failures).length} failing`);
      return { engine, failures };
    }));
    for (const { engine, failures } of results) {
      for (const cell of boardCells) {
        const key = `${engine.name}:${cell.id}`;
        const cause = causeOf(key);
        if (failures[cell.id] && !cause) unexpected.push(`${key}: ${failures[cell.id]}`);
        if (!failures[cell.id] && cause) unexpected.push(`${key} now passes; remove it from #${cause.item}'s cells`);
      }
    }
    if (process.env.PULLBOARD_SHAPES_REPORT) {
      const { appendFileSync } = await import('node:fs');
      for (const row of report) appendFileSync(process.env.PULLBOARD_SHAPES_REPORT, JSON.stringify({ boards, ...row }) + '\n');
    }
    assert.deepEqual(unexpected, [], 'every cell shows its board or names its blocker, or is a filed defect');
  });
}


test('a revoked browser sees the removed screen on a computer and a phone [H5,H17,N26]', {
  timeout: 900_000, // budget: hang ceiling for the 72 scoped revoked cells, including real enrollment and both engines.
  skip: !REVOKED_PROOF && 'scoped acceptance: set PULLBOARD_REVOKED_PROOF=1; both real engines remain required',
}, async t => {
  const available = hostedEngines();
  for (const name of ['chromium', 'webkit']) {
    assert.ok(available.find(engine => engine.name === name)?.available, name + ' is required for the revoked-cell proof');
  }
  const engines = [];
  t.after(async () => {
    const outcomes = await Promise.allSettled(engines.map(engine => engine.close()));
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  });
  for (const name of ['chromium', 'webkit']) engines.push(await openEngine(name));
  const visited = [];
  for (const boards of ['healthy', 'oversize', 'approval', 'mixed']) await t.test(boards, async scope => {
    const built = await buildBoards(scope, boards, engines);
    scope.after(async () => {
      const outcomes = await Promise.allSettled(Object.values(built.revoked).map(identity => identity.context.close()));
      for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
    });
    const boardIds = built.linked.map(({ id }) => id);
    for (const engine of engines) {
      const identity = built.revoked[engine.name];
      for (const key of REVOKED_981_CELLS.filter(key => key.startsWith(engine.name + ':') && key.split('/')[3] === boards)) {
        const cell = cells().find(cell => engine.name + ':' + cell.id === key);
        assert.ok(cell, key + ' is an actual committed matrix cell');
        const page = await identity.context.newPage({ route: built.front.route(identity.session, null),
          phone: cell.where === 'phone', bootstrap: storedScript(cell.stored, { keys: null, boards: boardIds }) });
        try {
          await page.navigate(HOSTED + '/');
          const removed = await page.poll(`(() => {
            const seen = node => { if (!node) return false; const rect = node.getBoundingClientRect();
              const style = getComputedStyle(node); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; };
            const panel = document.getElementById('relay-removed');
            if (!seen(panel)) return false;
            return { words: panel.innerText, competing: ['#relay-screen', '#relay-notice', '#local-note', '.first']
              .filter(selector => seen(document.querySelector(selector))),
              otherSignIns: [...document.querySelectorAll('a,button')].filter(node => !panel.contains(node) && seen(node) && /sign in with github/i.test(node.textContent)).length,
              actions: [...panel.querySelectorAll('a,button')].filter(seen)
              .map(node => ({ text: node.textContent.trim(), href: node.getAttribute('href') })) };
          })()`, 8_000); // budget: existing matrix blocker-settle ceiling, not a performance assertion.
          assert.ok(removed, key + ': visible removed screen required; ' + JSON.stringify(await page.evaluate(READ_SCREEN)));
          assert.match(removed.words, /removed/iu, key);
          assert.deepEqual(removed.competing, [], key + ': removed screen has priority over other blocker panels');
          assert.equal(removed.otherSignIns, 0, key + ': no competing sign-in action outside the removed screen');
          assert.deepEqual(removed.actions, [{ text: 'Sign in with GitHub', href: '/auth/github/start' }], key + ': exactly one actionable recovery step');
          const screen = await page.evaluate(READ_SCREEN);
          assert.equal(screen.board, false, key + ': revoked identity cannot display private board content');
          visited.push(key);
        } finally { await page.close(); }
      }
    }
  });
  assert.deepEqual(visited.sort(), [...REVOKED_981_CELLS].sort(), 'every one of the exact 72 revoked keys ran once');
});


/** Read private identity only inside this fixture; assertion messages never include its values. */
async function savedIdentity(page) {
  await page.evaluate(`(() => { delete window.__identityRead981;
    const request = indexedDB.open('pullboard-relay-device-v1', 1);
    request.onsuccess = () => { const db = request.result;
      try { const read = db.transaction('keys').objectStore('keys').get('device');
        read.onsuccess = () => { try { const device = read.result; window.__identityRead981 = { id: device?.deviceId,
          extractable: device?.privateKey?.extractable, keys: localStorage.getItem('pullboard.relay.keys.v1') }; }
          catch { window.__identityRead981 = { failed: true }; } finally { db.close(); } };
        read.onerror = () => { db.close(); window.__identityRead981 = { failed: true }; };
      } catch { db.close(); window.__identityRead981 = { failed: true }; } };
    request.onerror = () => { window.__identityRead981 = { failed: true }; }; })()`);
  try {
    const identity = await page.poll('window.__identityRead981', 8_000); // budget: existing hosted blocker-settle ceiling.
    assert.ok(identity && !identity.failed, 'fixture identity read completed');
    return identity;
  } finally { await page.evaluate('delete window.__identityRead981'); }
}

test('an expired saved pairing preserves a valid identity when its session probe succeeds or is unavailable [H5,H17,N26]', {
  skip: !REVOKED_PROOF && 'scoped acceptance: set PULLBOARD_REVOKED_PROOF=1',
}, async t => {
  assert.ok(hostedEngines().find(engine => engine.name === 'chromium')?.available, 'real Chromium is required');
  const box = await relayClientFixture(t);
  box.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_HOME;
  const front = await hostedFront(box.origin);
  let engine;
  let context;
  t.after(async () => {
    const outcomes = await Promise.allSettled([context?.close(), engine?.close(), front.close()]);
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  });
  engine = await openEngine('chromium');
  context = await engine.newContext();
  const session = await freshSession(box);
  let enrolled;
  let first;
  try {
    await relayOnAll(box, async link => {
      first = await context.newPage({ route: front.route(session, null), phone: true });
      await first.navigate(link);
    });
    assert.ok(await first.poll(`Boolean((${OPEN_BOARD}) && document.querySelector('#chain')?.textContent.includes('private cleanup fixture item')
      && Object.keys(JSON.parse(localStorage.getItem('pullboard.relay.keys.v1') || '{}')).length)`, 8_000), // budget: existing hosted blocker-settle ceiling.
    'the actual enrolled phone renders its seeded board and saves local keys');
    enrolled = await savedIdentity(first);
    assert.ok(enrolled.id, 'real enrollment saved a device identity');
    assert.equal(enrolled.extractable, false, 'real enrollment saved a nonextractable private key');
    assert.ok(enrolled.keys, 'real enrollment saved board keys');
  } finally { if (first) await first.close(); }
  for (const unavailable of [false, true]) await t.test(unavailable ? 'unavailable probe' : 'valid session', async () => {
    let probes = 0;
    let listings = 0;
    let unmatchedProbes = 0;
    const route = front.route(session, null);
    const page = await context.newPage({ phone: true, bootstrap: storedScript('stale-pairing'), route: async request => {
      if (new URL(request.url).pathname === '/api/v1/boards') listings += 1;
      if (new URL(request.url).pathname === '/api/v1/devices/session') {
        probes += 1;
        if (probes > listings) unmatchedProbes += 1;
        if (unavailable) return { kind: 'fulfill', status: 503, headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ version: 1, error: { code: 'RELAY_UNAVAILABLE', message: 'fixture session probe unavailable' } })) };
      }
      return route(request);
    } });
    try {
      await page.navigate(HOSTED + '/');
      if (unavailable) {
        const failure = await page.poll(`(() => { const node = document.querySelector('#relay-screen .relay-live span');
          return node?.textContent.includes('fresh phone pairing link') && node.textContent; })()`, 8_000); // budget: existing hosted blocker-settle ceiling.
        assert.ok(failure, 'unavailable authorization retains the original expired pairing guidance');
        assert.match(failure, /pullboard relay on --all/u);
        assert.doesNotMatch(failure, /fixture session probe unavailable/u, 'probe errors do not replace the original pairing refusal');
      } else {
        // #982 intentionally replaces the former expired-link blocker for an authorized paired browser.
        assert.ok(await page.poll(`(${READ_SCREEN}).board`, 8_000), 'valid paired identity opens its board despite the expired link'); // budget: fixture settle ceiling.
        assert.doesNotMatch((await page.evaluate(READ_SCREEN)).words, /fresh phone pairing link/u);
      }
      if (unavailable) assert.equal(probes, 1, 'only the cause-specific session probe ran');
      else {
        assert.ok(probes > 0, 'the opened board performs normal session authorization');
        assert.equal(unmatchedProbes, 0, 'no expiry-only session probe runs before or beyond the observed board listings');
      }
      const screen = await page.evaluate(READ_SCREEN);
      assert.doesNotMatch(screen.words, /browser was removed/iu, 'a valid or unavailable session is not a revocation');
      assert.equal(await page.evaluate("document.getElementById('relay-removed') !== null"), false);
      assert.equal(await page.evaluate("sessionStorage.getItem('pullboard.relay.device-pair.v1')"), null, 'the expired pending code is discarded normally');
      const retained = await savedIdentity(page);
      assert.ok(retained.id === enrolled.id, 'the existing device identity is retained');
      assert.equal(retained.extractable, false, 'the existing private key remains nonextractable');
      assert.ok(retained.keys === enrolled.keys, 'unrelated valid board keys are retained');
      assert.ok(enrolledDevices(box).includes(enrolled.id), 'the real enrolled device remains active');
    } finally { await page.close(); }
  });
});

/** Exercise stale enrollment through real saved keys, a real local view, and an unpaired control. */
test('an expired pairing link left in sessionStorage never blocks a paired browser or the board computer\'s view [H5,H17,N26]', async t => {
  assert.ok(hostedEngines().find(engine => engine.name === 'chromium')?.available, 'real Chromium is required');
  const box = await relayClientFixture(t);
  box.env.PULLBOARD_MACHINE_HOME = box.env.PULLBOARD_HOME;
  const front = await hostedFront(box.origin);
  const engine = await openEngine('chromium');
  const paired = await engine.newContext();
  t.after(async () => {
    const outcomes = await Promise.allSettled([paired.close(), engine.close(), front.close()]);
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  });
  const session = await freshSession(box);
  let first;
  try {
    await relayOnAll(box, async link => {
      first = await paired.newPage({ route: front.route(session, null), phone: true });
      await first.navigate(link);
    });
    assert.ok(await first.poll(OPEN_BOARD, 8_000), 'real enrollment opens the seeded board'); // budget: fixture settle ceiling, not a speed bar.
  } finally { if (first) await first.close(); }
  await t.test('already paired phone retains access', async () => {
    const page = await paired.newPage({ route: front.route(session, null), phone: true, bootstrap: storedScript('stale-pairing') });
    try {
      await page.navigate(HOSTED + '/');
      assert.ok(await page.poll(OPEN_BOARD, 8_000), 'saved enrollment opens its board despite expired pending pairing'); // budget: fixture settle ceiling.
      assert.equal(await page.evaluate("sessionStorage.getItem('pullboard.relay.device-pair.v1')"), null);
      assert.doesNotMatch((await page.evaluate(READ_SCREEN)).words, /fresh phone pairing link|DEVICE_PAIR_EXPIRED/u);
    } finally { await page.close(); }
  });
  const view = await boardView(box);
  t.after(() => view.stop());
  await t.test('board computer uses its own view', async () => {
    const context = await engine.newContext();
    try {
      const seen = await visit(context, { route: front.route(session, view.base), phone: false,
        bootstrap: storedScript('stale-pairing'), localView: view.base + '/local/view' }, true);
      assert.ok(seen.board, 'the actual running local view remains readable');
      assert.doesNotMatch(seen.words, /fresh phone pairing link|DEVICE_PAIR_EXPIRED/u);
    } finally { await context.close(); }
  });
  await t.test('unpaired phone still needs a fresh link', async () => {
    const context = await engine.newContext();
    const page = await context.newPage({ route: front.route(session, null), phone: true, bootstrap: storedScript('stale-pairing') });
    try {
      await page.navigate(HOSTED + '/');
      assert.ok(await page.poll(`(${READ_SCREEN}).words.includes('fresh phone pairing link')`, 8_000), 'unpaired browser gets actionable expiry guidance'); // budget: fixture settle ceiling.
      assert.equal((await page.evaluate(READ_SCREEN)).board, false);
      assert.equal(await page.evaluate("sessionStorage.getItem('pullboard.relay.device-pair.v1')"), null);
    } finally { await context.close(); }
  });
});
