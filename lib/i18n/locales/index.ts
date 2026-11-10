// One table per language, nested by screen. English is the source every
// other table follows key for key, as test/locales.test.ts checks.
import ar from "./ar.json";
import bg from "./bg.json";
import ca from "./ca.json";
import cs from "./cs.json";
import da from "./da.json";
import de from "./de.json";
import el from "./el.json";
import en from "./en.json";
import es from "./es.json";
import et from "./et.json";
import eu from "./eu.json";
import fa from "./fa.json";
import fi from "./fi.json";
import fr from "./fr.json";
import gl from "./gl.json";
import he from "./he.json";
import hi from "./hi.json";
import hr from "./hr.json";
import hu from "./hu.json";
import id from "./id.json";
import is from "./is.json";
import it from "./it.json";
import ja from "./ja.json";
import ko from "./ko.json";
import lt from "./lt.json";
import lv from "./lv.json";
import ms from "./ms.json";
import nl from "./nl.json";
import no from "./no.json";
import pl from "./pl.json";
import pt from "./pt.json";
import ro from "./ro.json";
import ru from "./ru.json";
import sk from "./sk.json";
import sl from "./sl.json";
import sr from "./sr.json";
import sv from "./sv.json";
import th from "./th.json";
import tr from "./tr.json";
import uk from "./uk.json";
import vi from "./vi.json";
import zh from "./zh.json";

export type Table = { [key: string]: string | Table };

export const tables: Record<string, Table> = {
  ar, bg, ca, cs, da, de, el, en, es, et, eu, fa, fi, fr, gl, he, hi, hr, hu, id, is, it, ja, ko, lt, lv, ms, nl, no, pl, pt, ro, ru, sk, sl, sr, sv, th, tr, uk, vi, zh,
};
