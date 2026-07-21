export type Loc = { file: string; line: number; column: number };

export class ComptimeTransformError extends Error {
    readonly loc: Loc;
    readonly frame: string;

    constructor(message: string, loc: Loc, frame: string) {
        super(message);
        this.name = 'ComptimeTransformError';
        this.loc = loc;
        this.frame = frame;
    }
}

/**
 * Source location and a caret frame for the byte offset `pos` in `code`, used to
 * point a diagnostic at the original call site.
 */
export function getLocAndFrame(
    code: string,
    pos: number,
    id: string,
): { loc: Loc; frame: string } {
    const before = code.slice(0, pos);
    const lines = before.split('\n');
    const line = lines.length;
    const column = lines[lines.length - 1].length + 1;
    const sourceLine = code.split('\n')[line - 1] ?? '';
    return {
        loc: { file: id, line, column },
        frame: `${sourceLine}\n${' '.repeat(column - 1)}^`,
    };
}
