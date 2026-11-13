import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App, APP_TITLE } from '../App';

describe('App', () => {
  it('renders the placeholder heading inside the main landmark', () => {
    expect(renderToStaticMarkup(<App />)).toBe(`<main><h1>${APP_TITLE}</h1></main>`);
  });
});
