/// <reference types="next" />
/// <reference types="next/image-types/global" />

// Keep framework and image types available to standalone tsc before a Next build.
declare module '*.css' {
    const content: { [className: string]: string };
    export default content;
  }