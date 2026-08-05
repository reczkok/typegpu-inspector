const canvas = document.querySelector('canvas') as HTMLCanvasElement;
const context = canvas.getContext('2d');

if (!context) {
  throw new Error('Expected a 2D canvas context.');
}

export const controls = {
  width: canvas.width,
  height: canvas.height,
};
