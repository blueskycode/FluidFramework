/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import {
    BaseSegment,
    IJSONSegment,
    ISegment,
    LocalClientId,
    PropertySet,
    UniversalSequenceNumber,
} from "@prague/merge-tree";
import { IComponentRuntime, ISharedObjectServices } from "@prague/runtime-definitions";
import { ISharedObject, ISharedObjectExtension } from "@prague/shared-object-common";
import {
    SharedSegmentSequence,
    SubSequence,
} from ".";

export type UnboxedOper = undefined | boolean | number | string;

// An empty segment that occupies 'cachedLength' positions.  SparseMatrix uses PaddingSegment
// to "pad" a run of unoccupied cells.
export class PaddingSegment extends BaseSegment {
    public static readonly typeString = "PaddingSegment";
    public static is(segment: ISegment): segment is PaddingSegment {
        return segment.type === PaddingSegment.typeString;
    }
    public static fromJSONObject(spec: any) {
        if (spec && typeof spec === "object" && "pad" in spec) {
            const segment = new PaddingSegment(spec.pad, UniversalSequenceNumber, LocalClientId);
            if (spec.props) {
                segment.addProperties(spec.props);
            }
            return segment;
        }
        return undefined;
    }
    public readonly type = PaddingSegment.typeString;

    constructor(size: number, seq?: number, clientId?: number) {
        super(seq, clientId);
        this.cachedLength = size;
    }

    public toJSONObject() {
        return { pad: this.cachedLength, props: this.properties };
    }

    public clone(start = 0, end?: number) {
        const b = new PaddingSegment(this.cachedLength, this.seq, this.clientId);
        this.cloneInto(b);
        return b;
    }

    public canAppend(segment: ISegment) {
        return PaddingSegment.is(segment);
    }

    public toString() {
        return `[padding: ${this.cachedLength}]`;
    }

    public append(segment: ISegment) {
        if (!PaddingSegment.is(segment)) {
            throw new Error("can only append padding segment");
        }

        // Note: Must call 'appendLocalRefs' before modifying this segment's length as
        //       'this.cachedLength' is used to adjust the offsets of the local refs.
        this.appendLocalRefs(segment);

        this.cachedLength += segment.cachedLength;
    }

    // returns true if entire run removed
    public removeRange(start: number, end: number) {
        this.cachedLength -= (end - start);
        return (this.cachedLength === 0);
    }

    protected createSplitSegmentAt(pos: number) {
        const leftLength = pos;
        const rightLength = this.cachedLength - pos;

        this.cachedLength = leftLength;
        return new PaddingSegment(rightLength, this.seq, this.clientId);
    }
}

export class RunSegment extends SubSequence<UnboxedOper> {
    public static readonly typeString = "RunSegment";
    public static is(segment: ISegment): segment is RunSegment {
        return segment.type === RunSegment.typeString;
    }
    public static fromJSONObject(spec: any) {
        if (spec && typeof spec === "object" && "items" in spec) {
            const segment = new RunSegment(spec.items, UniversalSequenceNumber, LocalClientId);
            if (spec.props) {
                segment.addProperties(spec.props);
            }
            return segment;
        }
        return undefined;
    }
    public readonly type = RunSegment.typeString;

    private tags: any[];

    constructor(public items: UnboxedOper[], seq?: number, clientId?: number) {
        super(items, seq, clientId);
        this.tags = new Array(items.length).fill(undefined);
    }

    public clone(start = 0, end?: number) {
        const b = new RunSegment(this.items.slice(start, end), this.seq, this.clientId);
        if (this.tags) {
            b.tags = this.tags.slice(start, end);
        }
        this.cloneInto(b);
        return b;
    }

    public append(segment: ISegment) {
        super.append(segment);

        const asRun = segment as RunSegment;
        if (asRun.tags) {
            if (this.tags) {
                this.tags.splice(this.items.length, 0, ...asRun.tags);
            }
        }

        return this;
    }

    // TODO: retain removed items for undo
    // returns true if entire run removed
    public removeRange(start: number, end: number) {
        this.tags.splice(start, end - start);
        return super.removeRange(start, end);
    }

    public getTag(pos: number) {
        return this.tags[pos];
    }

    public setTag(pos: number, tag: any) {
        this.tags[pos] = tag;
    }

    protected createSplitSegmentAt(pos: number) {
        if (pos > 0) {
            const remainingItems = this.items.slice(pos);
            this.items = this.items.slice(0, pos);
            this.cachedLength = this.items.length;

            const leafSegment = new RunSegment(remainingItems, this.seq, this.clientId);
            leafSegment.tags = this.tags.slice(pos);
            this.tags.length = pos;

            return leafSegment;
        }
    }
}

export type MatrixSegment = RunSegment | PaddingSegment;

export const maxCol = 0x200000;         // x128 Excel maximum of 16,384 columns
export const maxCols = maxCol + 1;

export const maxRow = 0xFFFFFFFF;       // x4096 Excel maximum of 1,048,576 rows
export const maxRows = maxRow + 1;

export const maxCellPosition = maxCol * maxRow;

export function rowColToPosition(row: number, col: number) {
    return row * maxCols + col;
}

export function positionToRowCol(position: number) {
    const row = Math.floor(position / maxCols);
    const col = position - (row * maxCols);
    return { row, col };
}

export class SparseMatrix extends SharedSegmentSequence<MatrixSegment> {
    /**
     * Create a new sparse matrix
     *
     * @param runtime - component runtime the new sparse matrix belongs to
     * @param id - optional name of the sparse matrix
     * @returns newly create sparse matrix (but not attached yet)
     */
    public static create(runtime: IComponentRuntime, id?: string) {
        return runtime.createChannel(SharedSegmentSequence.getIdForCreate(id),
            SparseMatrixExtension.Type) as SparseMatrix;
    }

    /**
     * Get a factory for SharedMap to register with the component.
     *
     * @returns a factory that creates and load SharedMap
     */
    public static getFactory(): ISharedObjectExtension {
        return new SparseMatrixExtension();
    }

    constructor(document: IComponentRuntime, public id: string) {
        super(document, id, SparseMatrixExtension.Type);
    }

    // "Replace" ops currently trigger an assert in 'BaseSegment.ack()'
    // (See https://github.com/Microsoft/Prague/issues/1783)
    //
    // public setItems(row: number, col: number, values: UnboxedOper[], props?: PropertySet) {
    //     const start = rowColToPosition(row, col);
    //     const end = start + values.length;
    //     const segment = new RunSegment(values);
    //     if (props) {
    //         segment.addProperties(props);
    //     }

    //     const insertMessage = {
    //         pos1: start,
    //         pos2: end,
    //         seg: segment.toJSONObject(),
    //         type: MergeTreeDeltaType.INSERT,
    //     } as IMergeTreeInsertMsg;

    //     this.client.insertSegmentLocal(start, segment, { op: insertMessage });
    //     this.submitSequenceMessage(insertMessage);
    // }

    // "Group" ops are currently not correctly handled by 'BaseSegment.ack()'
    // (See https://github.com/Microsoft/Prague/issues/1839)
    //
    // public setItems(row: number, col: number, values: UnboxedOper[], props?: PropertySet) {
    //     const start = rowColToPosition(row, col);
    //     const end = start + values.length;
    //     const segment = new RunSegment(values);
    //     if (props) {
    //         segment.addProperties(props);
    //     }

    //     const removeMessage = {
    //         pos1: start,
    //         pos2: end,
    //         type: MergeTreeDeltaType.REMOVE,
    //     } as IMergeTreeRemoveMsg;

    //     const insertMessage = {
    //         pos1: start,
    //         seg: segment.toJSONObject(),
    //         type: MergeTreeDeltaType.INSERT,
    //     } as IMergeTreeInsertMsg;

    //     const replaceMessage = {
    //         ops: [ removeMessage, insertMessage ],
    //         type: MergeTreeDeltaType.GROUP,
    //     } as IMergeTreeGroupMsg;

    //     this.groupOperation(replaceMessage);
    // }

    public get numRows() {
        return positionToRowCol(this.client.getLength()).row;
    }

    public setItems(row: number, col: number, values: UnboxedOper[], props?: PropertySet) {
        const start = rowColToPosition(row, col);
        const end = start + values.length;
        const segment = new RunSegment(values);
        if (props) {
            segment.addProperties(props);
        }

        this.replaceRange(start, end, segment);
    }

    public getItem(row: number, col: number) {
        const pos = rowColToPosition(row, col);
        const { segment, offset } =
            this.getContainingSegment(pos);
        if (RunSegment.is(segment)) {
            return segment.items[offset];
        } else if (PaddingSegment.is(segment)) {
            return undefined;
        }

        throw new Error(`Unrecognized Segment type: ${segment.constructor}`);
    }

    public getTag(row: number, col: number) {
        const { segment, offset } = this.getSegment(row, col);
        if (RunSegment.is(segment)) {
            return segment.getTag(offset);
        }
        return undefined;
    }

    public setTag(row: number, col: number, tag: any) {
        const { segment, offset } = this.getSegment(row, col);
        if (RunSegment.is(segment)) {
            segment.setTag(offset, tag);
        } else if (tag !== undefined) {
            throw new Error(`Must not attempt to set tags on '${segment.constructor.name}'.`);
        }
    }

    public insertRows(row: number, numRows: number) {
        const pos = rowColToPosition(row, 0);
        const size = maxCols * numRows;
        const segment = new PaddingSegment(size);

        const insertOp = this.client.insertSegmentLocal(pos, segment);
        if (insertOp) {
            this.submitSequenceMessage(insertOp);
        }
    }

    public removeRows(row: number, numRows: number) {
        const pos = rowColToPosition(row, 0);
        const size = maxCols * numRows;
        this.removeRange(pos, pos + size);
    }

    public insertCols(col: number, numCols: number) {
        this.moveAsPadding(maxCol - numCols, col, numCols);
    }

    public removeCols(col: number, numCols: number) {
        this.moveAsPadding(col, maxCol - numCols, numCols);
    }

    public segmentFromSpec(spec: IJSONSegment): ISegment {
        const maybePadding = PaddingSegment.fromJSONObject(spec);
        if (maybePadding) {
            return maybePadding;
        }

        const maybeRun = RunSegment.fromJSONObject(spec);
        if (maybeRun) {
            return maybeRun;
        }

        throw new Error(`Unrecognized IJSONObject: '${JSON.stringify(spec)}'`);
    }

    // For each row, moves 'numCols' items starting from 'srcCol' and inserts 'numCols' padding
    // at 'destCol'.  Used by insertCols and removeCols.
    private moveAsPadding(srcCol: number, destCol: number, numCols: number) {
        const removeColStart = srcCol;
        const removeColEnd = srcCol + numCols;

        // Note: The removes/inserts need to be made atomic:
        // (See https://github.com/Microsoft/Prague/issues/1840)

        for (let r = 0, rowStart = 0; r < this.numRows; r++ , rowStart += maxCols) {
            this.removeRange(rowStart + removeColStart, rowStart + removeColEnd);

            const insertPos = rowStart + destCol;
            const segment = new PaddingSegment(numCols, UniversalSequenceNumber, LocalClientId);

            const insertOp = this.client.insertSegmentLocal(insertPos, segment);
            if (insertOp) {
                this.submitSequenceMessage(insertOp);
            }
        }
    }

    private getSegment(row: number, col: number) {
        const pos = rowColToPosition(row, col);
        return this.getContainingSegment(pos);
    }
}

export class SparseMatrixExtension implements ISharedObjectExtension {
    public static Type = "https://graph.microsoft.com/types/mergeTree/sparse-matrix";

    public type: string = SparseMatrixExtension.Type;
    public readonly snapshotFormatVersion: string = "0.1";

    public async load(
        document: IComponentRuntime,
        id: string,
        minimumSequenceNumber: number,
        services: ISharedObjectServices,
        headerOrigin: string,
    ): Promise<ISharedObject> {
        const sharedObject = new SparseMatrix(document, id);
        await sharedObject.load(minimumSequenceNumber, headerOrigin, services);
        return sharedObject;
    }

    public create(document: IComponentRuntime, id: string): ISharedObject {
        const sharedObject = new SparseMatrix(document, id);
        sharedObject.initializeLocal();
        return sharedObject;
    }
}
