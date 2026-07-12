import { useCallback, useRef, useState } from 'react';
import type { MouseEvent, RefObject } from 'react';

function setColumnDragCursor(active: boolean): void {
  document.body.style.cursor = active ? 'col-resize' : '';
  document.body.style.userSelect = active ? 'none' : '';
}

function attachDragListeners(
  startXRef: RefObject<number>,
  onResize: (delta: number) => void,
  onDragEnd: () => void,
): void {
  const onMouseMove = (e: globalThis.MouseEvent) => {
    const delta = e.clientX - startXRef.current;
    startXRef.current = e.clientX;
    onResize(delta);
  };
  const onMouseUp = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    onDragEnd();
  };
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
}

interface ResizeHandleProps {
  onResize: (delta: number) => void;
}

function ResizeHandle({ onResize }: ResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);

  const onMouseDown = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      startX.current = e.clientX;
      setDragging(true);
      setColumnDragCursor(true);
      attachDragListeners(startX, onResize, () => {
        setDragging(false);
        setColumnDragCursor(false);
      });
    },
    [onResize],
  );

  return <div className={`resize-handle${dragging ? ' active' : ''}`} onMouseDown={onMouseDown} />;
}

export default ResizeHandle;
