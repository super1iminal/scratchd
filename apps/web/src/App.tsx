import { useEffect, useState } from 'react';
import { Home } from './components/Home';
import { PadView } from './components/PadView';

export function App() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);

  const pad = path.match(/^\/p\/([0-9a-f]+)$/);
  return pad ? <PadView key={pad[1]} padId={pad[1]} /> : <Home />;
}
