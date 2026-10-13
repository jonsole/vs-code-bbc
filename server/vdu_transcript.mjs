// What a program printed, as a transcript: the characters sent to the VDU
// (through OSWRCH) in the order they were sent, with the control codes
// reduced to what text needs. Where something was printed on the screen is
// not kept -- that is get_screen_text's job, read from the screen itself --
// so text printed before a CLS can never be mixed into text printed after it.
//
//   printable characters   as they are
//   CR, LF                 a newline (a CR LF or LF CR pair is one)
//   VDU 12 (CLS), 22 (MODE) a form feed, \f: "the screen was cleared here"
//   VDU 127 (DELETE)       takes back the character before it
//   anything else          dropped, with the parameter bytes it takes
//
// Kept free of jsbeeb, so it can be tested on its own.

// How many parameter bytes follow each VDU code that takes any.
const ParameterBytes = { 1: 1, 17: 1, 18: 2, 19: 5, 22: 1, 23: 9, 24: 8, 25: 5, 28: 4, 29: 4, 31: 2 };
const MaxLength = 64 * 1024;

export class VduTranscript {
    constructor() {
        this._text = "";
        this._skip = 0; // parameter bytes still to come
        this._pending = null; // the code they belong to
        this._lastNewline = null; // 10 or 13 if the last thing was that newline
    }

    /** One byte sent to OSWRCH. */
    write(code) {
        code &= 0xff;
        if (this._skip > 0) {
            this._skip--;
            if (this._skip === 0 && this._pending === 22) this._append("\f");
            return;
        }
        if (ParameterBytes[code] !== undefined) {
            this._skip = ParameterBytes[code];
            this._pending = code;
            this._lastNewline = null;
            return;
        }
        if (code === 10 || code === 13) {
            // CR LF and LF CR are one line break, however the OS orders them.
            if (this._lastNewline !== null && this._lastNewline !== code) {
                this._lastNewline = null;
                return;
            }
            this._append("\n");
            this._lastNewline = code;
            return;
        }
        this._lastNewline = null;
        if (code === 12) {
            this._append("\f");
        } else if (code === 127) {
            const last = this._text.at(-1);
            if (last !== undefined && last !== "\n" && last !== "\f") this._text = this._text.slice(0, -1);
        } else if (code >= 32 && code < 127) {
            this._append(String.fromCharCode(code));
        } else if (code >= 128) {
            // Teletext control codes and graphics: a space holds their place.
            this._append(" ");
        }
    }

    _append(s) {
        this._text += s;
        if (this._text.length > MaxLength) this._text = this._text.slice(-MaxLength);
    }

    /** The transcript since it was last taken; `clear: false` leaves it to be taken again. */
    take({ clear = true } = {}) {
        const text = this._text;
        if (clear) this._text = "";
        return text;
    }
}
