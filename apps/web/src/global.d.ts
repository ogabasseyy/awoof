/// <reference types="next" />
/// <reference types="next/image-types/global" />

// Make standalone type checks independent of generated Next files.
declare module '*.css' {
    const content: { [className: string]: string };
    export default content;
  }