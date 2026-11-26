import { flatRoutes as scan } from '@react-router/fs-routes';
const ignoredRouteFiles = ['screens/ignored.tsx'];
export default [...await scan({ rootDirectory: 'screens', ignoredRouteFiles })];
