import React, { useCallback, useRef, useState } from 'react';

function ResizeHandle({ onResize }) {
  const [dragging, setDragging] = useState(false);
  const startX = useRef(0);

  const onMouseDown = useCallback((e) => {
    e.preventDefault();
    startX.current = e.clientX;
    setDragging(true);

    const onMouseMove = (e) => {
      const delta = e.clientX - startX.current;
      startX.current = e.clientX;
      onResize(delta);
    };

    const onMouseUp = () => {
      setDragging(false);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [onResize]);

  return (
    <div
      className={`resize-handle${dragging ? ' active' : ''}`}
      onMouseDown={onMouseDown}
    />
  );
}

export default ResizeHandle;
