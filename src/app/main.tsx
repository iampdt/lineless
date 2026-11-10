import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Centered, Footer, Header } from "./components/ui";
import { Display } from "./pages/Display";
import { Home } from "./pages/Home";
import { Join } from "./pages/Join";
import { Staff } from "./pages/Staff";
import { Link, match, usePath } from "./router";
import "./styles.css";

function App() {
  const route = match(usePath());
  switch (route.page) {
    case "home":
      return <Home />;
    case "join":
      return <Join code={route.code} embedded={new URLSearchParams(window.location.search).has("embed")} />;
    case "staff":
      return <Staff code={route.code} />;
    case "display":
      return <Display code={route.code} />;
    case "missing":
      return (
        <div className="min-h-screen">
          <Header />
          <Centered>
            <h1 className="text-2xl font-bold">There's nothing here</h1>
            <Link to="/" className="btn-primary">
              Go to the home page
            </Link>
          </Centered>
          <Footer />
        </div>
      );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
