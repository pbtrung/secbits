import { useCallback, useRef, useState } from 'react';

function setColumnDragCursor(active) {
  document.body.style.cursor = active ? 'col-resize' : '';
  document.body.style.userSelect = active ? 'none' : '';
}

function attachDragListeners(startXRef, onResize, onDragEnd) {
  const onMouseMove = (e) => {
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

function ResizeHandle({ onResize }) {
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);

  const onMouseDown = useCallback(
    (e) => {
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
