import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App, APP_TITLE } from '../App';

describe('App', () => {
  it('renders the placeholder heading', () => {
    expect(renderToStaticMarkup(<App />)).toBe(`<h1>${APP_TITLE}</h1>`);
  });
});
